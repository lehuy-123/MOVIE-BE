import { createServer } from 'http';
import { Server } from 'socket.io';

// Auto-load .env natively (supported in Node 20.6+) or safely ignore if already in process.env
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // .env not present or running in Docker/Cloud where env vars are already injected
  }
}

const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// Avatar palette for new viewers
const AVATAR_COLORS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f97316', // orange
];

// Default pre-seeded numbered cinema rooms
const DEFAULT_ROOMS = [
  {
    roomId: 'cinema-01',
    name: 'Rạp 01 · IMAX Star',
    order: 1,
    videoId: 'Sx5lJtEs56A',
    videoTitle: 'Tình Xưa Xa Rồi - Tiếng Hát Ngọc Lan',
  },
  {
    roomId: 'cinema-02',
    name: 'Rạp 02 · Âm Nhạc & Chill',
    order: 2,
    videoId: 'IcrbM1l_BoI',
    videoTitle: 'Avicii - Wake Me Up (Official Video)',
  },
  {
    roomId: 'cinema-03',
    name: 'Rạp 03 · Bom Tấn Điện Ảnh',
    order: 3,
    videoId: 'aqz-KE-bpKQ',
    videoTitle: 'Big Buck Bunny 4K 60fps',
  },
  {
    roomId: 'cinema-04',
    name: 'Rạp 04 · Anime & Hoạt Hình',
    order: 4,
    videoId: 'dQw4w9WgXcQ',
    videoTitle: 'Phim Ngắn Anime Cinema HD',
  },
  {
    roomId: 'cinema-05',
    name: 'Rạp 05 · Phòng Chiếu Riêng',
    order: 5,
    videoId: 'pPv3cU61_-M',
    videoTitle: 'YouTube Video (pPv3cU61_-M)',
  },
];

// Multi-room state storage: roomId -> RoomState
const rooms = new Map();
// Socket to room mapping: socketId -> roomId
const socketToRoom = new Map();

// Initialize default numbered rooms
DEFAULT_ROOMS.forEach((def) => {
  rooms.set(def.roomId, {
    roomId: def.roomId,
    name: def.name,
    order: def.order,
    hostId: null,
    videoId: def.videoId,
    videoTitle: def.videoTitle,
    status: 'playing',
    timestamp: 0,
    updatedAt: Date.now(),
    users: new Map(),
    skipVotes: new Set(),
    queue: [],
  });
});

// Helper to get or dynamically create a numbered cinema room
function getOrCreateRoom(roomId, customName) {
  let room = rooms.get(roomId);
  if (!room) {
    const order = rooms.size + 1;
    const name = customName || `Rạp ${order.toString().padStart(2, '0')} · wetube ciné`;
    room = {
      roomId,
      name,
      order,
      hostId: null,
      videoId: 'aqz-KE-bpKQ',
      videoTitle: 'Big Buck Bunny 4K 60fps',
      status: 'playing',
      timestamp: 0,
      updatedAt: Date.now(),
      users: new Map(),
      skipVotes: new Set(),
      queue: [],
    };
    rooms.set(roomId, room);
  }
  return room;
}

// Calculate real-time video timestamp accounting for elapsed playback for a specific room
function getCurrentTimestamp(room) {
  if (room.status === 'playing') {
    const elapsedSeconds = (Date.now() - room.updatedAt) / 1000;
    return Math.max(0, room.timestamp + elapsedSeconds);
  }
  return Math.max(0, room.timestamp);
}

function getSerializedUsers(room) {
  return Array.from(room.users.values());
}

function getSerializableRoomState(room) {
  return {
    roomId: room.roomId,
    name: room.name,
    order: room.order,
    hostId: room.hostId,
    videoId: room.videoId,
    videoTitle: room.videoTitle,
    status: room.status,
    timestamp: getCurrentTimestamp(room),
    updatedAt: room.updatedAt,
    serverTime: Date.now(),
    users: getSerializedUsers(room),
    skipVotes: Array.from(room.skipVotes),
    queue: room.queue,
  };
}

// Summary of all rooms for the Room Selector Modal
function getAllRoomsSummary() {
  const list = [];
  for (const room of rooms.values()) {
    list.push({
      roomId: room.roomId,
      name: room.name,
      order: room.order,
      viewersCount: room.users.size,
      videoId: room.videoId,
      videoTitle: room.videoTitle,
      status: room.status,
    });
  }
  return list.sort((a, b) => a.order - b.order);
}

const httpServer = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check endpoint for cloud platforms
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        service: '3D Cinema Multi-Room WebSocket Server',
        serverTime: Date.now(),
        totalRooms: rooms.size,
        rooms: getAllRoomsSummary(),
      })
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('3D Cinema Real-time Multi-Room Server running on port ' + PORT);
});

const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Helper: Handle a user leaving their current room
function leaveCurrentRoom(socket) {
  const currentRoomId = socketToRoom.get(socket.id);
  if (!currentRoomId) return;

  const room = rooms.get(currentRoomId);
  if (room) {
    const user = room.users.get(socket.id);
    room.users.delete(socket.id);
    room.skipVotes.delete(socket.id);

    console.log(`[Cinema] User ${user?.nickname || socket.id} left room "${room.name}" (${currentRoomId})`);

    // If host left, transfer host to next user in this room
    if (socket.id === room.hostId) {
      const nextUser = room.users.values().next().value;
      if (nextUser) {
        room.hostId = nextUser.socketId;
        nextUser.isAdmin = true;
        console.log(`[Cinema] 👑 New host assigned in ${room.name}: ${nextUser.nickname}`);
      } else {
        room.hostId = null;
      }
    }

    socket.leave(currentRoomId);
    io.to(currentRoomId).emit('user-left', {
      socketId: socket.id,
      seatId: user?.seatId || null,
    });
    io.to(currentRoomId).emit('users-updated', getSerializedUsers(room));
    io.to(currentRoomId).emit('room-state', getSerializableRoomState(room));
  }

  socketToRoom.delete(socket.id);
}

io.on('connection', (socket) => {
  console.log(`[Socket.io] New client connected: ${socket.id}`);

  // Send current rooms summary to client immediately upon connection
  socket.emit('rooms-list', getAllRoomsSummary());

  // 1. Client joins a specific cinema room (defaults to cinema-01)
  socket.on('join-room', ({ roomId = 'cinema-01', nickname, avatarColor, gender }) => {
    // Leave previous room if already joined one
    leaveCurrentRoom(socket);

    const room = getOrCreateRoom(roomId);
    socket.join(roomId);
    socketToRoom.set(socket.id, roomId);

    // If no active host in this room, first user becomes Host/Admin of this room!
    const isFirstUser = !room.hostId || !room.users.has(room.hostId);
    if (isFirstUser) {
      room.hostId = socket.id;
    }

    const randomColor =
      avatarColor || AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    const viewerName = nickname || (isFirstUser ? 'Admin' : `Viewer_${socket.id.substring(0, 4)}`);

    const user = {
      socketId: socket.id,
      nickname: viewerName,
      seatId: null,
      avatarColor: randomColor,
      gender: gender || 'Nam',
      joinedAt: Date.now(),
      isAdmin: socket.id === room.hostId,
    };

    room.users.set(socket.id, user);

    console.log(
      `[Cinema] ${viewerName} (${user.isAdmin ? '👑 ADMIN' : 'Viewer'}) joined [${room.name}]. Room viewers: ${room.users.size}`
    );

    // Send full current room state (movie, timestamp, users) to newly joined client
    socket.emit('room-state', getSerializableRoomState(room));

    // Notify other viewers in this room
    socket.to(roomId).emit('user-joined', user);
    io.to(roomId).emit('users-updated', getSerializedUsers(room));

    // Update rooms list summary for all clients
    io.emit('rooms-list', getAllRoomsSummary());
  });

  // 1.1 Client switches room
  socket.on('switch-room', ({ newRoomId, nickname, avatarColor, gender }) => {
    if (!newRoomId) return;
    leaveCurrentRoom(socket);

    const room = getOrCreateRoom(newRoomId);
    socket.join(newRoomId);
    socketToRoom.set(socket.id, newRoomId);

    const isFirstUser = !room.hostId || !room.users.has(room.hostId);
    if (isFirstUser) {
      room.hostId = socket.id;
    }

    const randomColor =
      avatarColor || AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    const viewerName = nickname || (isFirstUser ? 'Admin' : `Viewer_${socket.id.substring(0, 4)}`);

    const user = {
      socketId: socket.id,
      nickname: viewerName,
      seatId: null,
      avatarColor: randomColor,
      gender: gender || 'Nam',
      joinedAt: Date.now(),
      isAdmin: socket.id === room.hostId,
    };

    room.users.set(socket.id, user);

    console.log(`[Cinema] User ${viewerName} switched to [${room.name}]`);
    socket.emit('room-state', getSerializableRoomState(room));
    socket.to(newRoomId).emit('user-joined', user);
    io.to(newRoomId).emit('users-updated', getSerializedUsers(room));
    io.emit('rooms-list', getAllRoomsSummary());
  });

  // 1.2 Client requests room list
  socket.on('get-rooms', () => {
    socket.emit('rooms-list', getAllRoomsSummary());
  });

  // 1.3 Client creates a new cinema room
  socket.on('create-room', ({ roomId, name }) => {
    if (!roomId) return;
    const room = getOrCreateRoom(roomId, name);
    io.emit('rooms-list', getAllRoomsSummary());
  });

  // 2. Client triggers play
  socket.on('user-play', (payload) => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return;

    const currentTs =
      typeof payload?.timestamp === 'number' ? payload.timestamp : getCurrentTimestamp(room);
    room.status = 'playing';
    room.timestamp = currentTs;
    room.updatedAt = Date.now();

    const syncPayload = {
      timestamp: currentTs,
      updatedAt: room.updatedAt,
      serverTime: Date.now(),
      status: 'playing',
      videoId: room.videoId,
      videoTitle: room.videoTitle,
      senderId: socket.id,
    };

    console.log(`[Sync ${room.name}] Play event from ${socket.id} at ${currentTs.toFixed(2)}s`);
    socket.to(room.roomId).emit('sync-play', syncPayload);
  });

  // 3. Client triggers pause
  socket.on('user-pause', (payload) => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return;

    const currentTs =
      typeof payload?.timestamp === 'number' ? payload.timestamp : getCurrentTimestamp(room);
    room.status = 'paused';
    room.timestamp = currentTs;
    room.updatedAt = Date.now();

    const syncPayload = {
      timestamp: currentTs,
      updatedAt: room.updatedAt,
      serverTime: Date.now(),
      status: 'paused',
      videoId: room.videoId,
      videoTitle: room.videoTitle,
      senderId: socket.id,
    };

    console.log(`[Sync ${room.name}] Pause event from ${socket.id} at ${currentTs.toFixed(2)}s`);
    socket.to(room.roomId).emit('sync-pause', syncPayload);
  });

  // 4. Client triggers seek
  socket.on('user-seek', (payload) => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return;

    if (typeof payload?.timestamp !== 'number') return;
    const seekTs = Math.max(0, payload.timestamp);
    room.timestamp = seekTs;
    room.updatedAt = Date.now();

    const syncPayload = {
      timestamp: seekTs,
      updatedAt: room.updatedAt,
      serverTime: Date.now(),
      status: room.status,
      videoId: room.videoId,
      videoTitle: room.videoTitle,
      senderId: socket.id,
    };

    console.log(`[Sync ${room.name}] Seek event from ${socket.id} to ${seekTs.toFixed(2)}s`);
    socket.to(room.roomId).emit('sync-seek', syncPayload);
  });

  // 5. Client changes video (Admin Only)
  socket.on('user-change-video', ({ videoId, videoTitle }) => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || !videoId) return;

    const user = room.users.get(socket.id);
    const isHost = socket.id === room.hostId || user?.isAdmin;

    if (!isHost) {
      socket.emit('error-message', {
        message: 'Chỉ Admin / Chủ phòng mới có quyền đổi phim trực tiếp. Bạn hãy gửi yêu cầu phim vào danh sách chờ nhé!',
      });
      return;
    }

    room.videoId = videoId;
    room.videoTitle = videoTitle || `YouTube Video (${videoId})`;
    room.timestamp = 0;
    room.status = 'playing';
    room.updatedAt = Date.now();
    room.skipVotes.clear();

    console.log(`[Sync ${room.name}] 🎬 Video changed to "${videoId}" ("${room.videoTitle}") by Admin ${user?.nickname || socket.id}`);
    io.to(room.roomId).emit('sync-video', {
      videoId,
      videoTitle: room.videoTitle,
      updatedAt: room.updatedAt,
      suggester: user?.nickname || 'Admin',
    });
    io.to(room.roomId).emit('room-state', getSerializableRoomState(room));
    io.emit('rooms-list', getAllRoomsSummary());
  });

  // 5.1 Viewer requests a video
  socket.on('request-video', ({ videoId, videoTitle }) => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || !videoId) return;

    const user = room.users.get(socket.id);
    const requestItem = {
      id: `req-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      videoId,
      videoTitle: videoTitle || `YouTube Video (${videoId})`,
      requestedBy: user?.nickname || 'Khán giả',
      requestedBySocketId: socket.id,
      createdAt: Date.now(),
    };
    room.queue.push(requestItem);

    console.log(`[Queue ${room.name}] 📥 ${user?.nickname} requested video "${requestItem.videoTitle}"`);
    io.to(room.roomId).emit('queue-updated', room.queue);
    io.to(room.roomId).emit('chat-message', {
      id: `sys-${Date.now()}`,
      socketId: 'system',
      nickname: 'Hệ Thống',
      seatId: null,
      avatarColor: '#fde047',
      message: `📥 ${user?.nickname || 'Khán giả'} vừa yêu cầu phim: "${requestItem.videoTitle}"`,
      createdAt: Date.now(),
    });
  });

  // 5.2 Admin manages queue
  socket.on('admin-manage-queue', ({ action, requestId, videoId, videoTitle }) => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return;

    const user = room.users.get(socket.id);
    const isHost = socket.id === room.hostId || user?.isAdmin;
    if (!isHost) return;

    if (action === 'play' && videoId) {
      room.queue = room.queue.filter((q) => q.id !== requestId);
      room.videoId = videoId;
      if (videoTitle) room.videoTitle = videoTitle;
      room.timestamp = 0;
      room.status = 'playing';
      room.updatedAt = Date.now();
      room.skipVotes.clear();

      io.to(room.roomId).emit('sync-video', {
        videoId,
        videoTitle: room.videoTitle,
        updatedAt: room.updatedAt,
        suggester: user?.nickname || 'Admin',
      });
      io.to(room.roomId).emit('room-state', getSerializableRoomState(room));
      io.to(room.roomId).emit('queue-updated', room.queue);
      io.emit('rooms-list', getAllRoomsSummary());
    } else if (action === 'remove' && requestId) {
      room.queue = room.queue.filter((q) => q.id !== requestId);
      io.to(room.roomId).emit('queue-updated', room.queue);
    }
  });

  // 5.3 Claim Admin role
  socket.on('claim-admin', ({ key } = {}) => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    const canClaim = !room.hostId || !room.users.has(room.hostId) || key === 'admin123' || room.users.size === 1;
    if (canClaim) {
      if (room.hostId && room.users.has(room.hostId)) {
        const prevHost = room.users.get(room.hostId);
        if (prevHost) prevHost.isAdmin = false;
      }
      room.hostId = socket.id;
      user.isAdmin = true;
      console.log(`[Admin ${room.name}] 👑 User ${user.nickname} claimed Admin role!`);
      io.to(room.roomId).emit('users-updated', getSerializedUsers(room));
      io.to(room.roomId).emit('room-state', getSerializableRoomState(room));
    }
  });

  // 6. Client selects seat
  socket.on('user-select-seat', ({ seatId }) => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    let isOccupied = false;
    for (const [sId, otherUser] of room.users.entries()) {
      if (sId !== socket.id && otherUser.seatId === seatId) {
        isOccupied = true;
        break;
      }
    }

    if (isOccupied) {
      console.log(`[Seat ${room.name}] Seat ${seatId} is already occupied.`);
      return;
    }

    user.seatId = seatId;
    console.log(`[Seat ${room.name}] User ${user.nickname} took seat ${seatId}`);
    io.to(room.roomId).emit('users-updated', getSerializedUsers(room));
  });

  // 7. Client leaves seat
  socket.on('user-leave-seat', () => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;
    const prevSeat = user.seatId;
    user.seatId = null;
    console.log(`[Seat ${room.name}] User ${user.nickname} left seat ${prevSeat}`);
    io.to(room.roomId).emit('users-updated', getSerializedUsers(room));
  });

  // 8. Client sends chat message
  socket.on('user-chat', ({ message }) => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || !message || typeof message !== 'string' || !message.trim()) return;

    const user = room.users.get(socket.id);
    const nickname = user?.nickname || `Viewer_${socket.id.substring(0, 4)}`;
    const seatId = user?.seatId || null;
    const avatarColor = user?.avatarColor || '#3b82f6';

    const chatPayload = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      socketId: socket.id,
      nickname,
      seatId,
      avatarColor,
      message: message.trim().substring(0, 200),
      createdAt: Date.now(),
    };

    console.log(`[Chat ${room.name}] ${nickname}: "${chatPayload.message}"`);
    io.to(room.roomId).emit('chat-message', chatPayload);
  });

  // 9. Client votes to skip video
  socket.on('user-vote-skip', () => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return;

    room.skipVotes.add(socket.id);
    const totalUsers = room.users.size;
    const voteCount = room.skipVotes.size;

    console.log(`[Vote Skip ${room.name}] Current: ${voteCount}/${totalUsers}`);
    io.to(room.roomId).emit('skip-votes-updated', {
      count: voteCount,
      total: totalUsers,
      voters: Array.from(room.skipVotes),
    });
  });

  // 10. Client updates profile
  socket.on('user-update-profile', ({ nickname, avatarColor, gender }) => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;
    if (nickname) user.nickname = nickname;
    if (avatarColor) user.avatarColor = avatarColor;
    if (gender) user.gender = gender;

    io.to(room.roomId).emit('users-updated', getSerializedUsers(room));
  });

  // 11. Client disconnects
  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
    io.emit('rooms-list', getAllRoomsSummary());
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n=================================================`);
  console.log(`🎬 3D Cinema Real-time Multi-Room Server started!`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`🌐 Total active rooms: ${rooms.size}`);
  rooms.forEach((r) => console.log(`   - [${r.roomId}] ${r.name} (Phim: ${r.videoTitle})`));
  console.log(`=================================================\n`);
});
