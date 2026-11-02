import { createServer } from 'http';
import { Server } from 'socket.io';
import crypto from 'crypto';

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

// ─── Tài khoản Admin (cấu hình qua biến môi trường) ───
// Khán giả thường KHÔNG cần đăng nhập: chỉ nhập tên + chọn màu áo + chọn ghế.
// Chỉ Admin mới cần tên + mật khẩu để đổi phim / điều khiển phát.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('[Admin] ⚠️  Đang dùng mật khẩu admin mặc định. Hãy đặt ADMIN_USERNAME / ADMIN_PASSWORD trong .env khi deploy!');
}

// socketId đang có quyền Admin
const adminSockets = new Set();
// Token phiên Admin (để giữ quyền khi reload trang / mất kết nối)
const adminTokens = new Set();
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'wetube_cine_admin_secret_2026';

function createAdminToken() {
  return crypto.createHmac('sha256', ADMIN_SECRET).update(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const expected = createAdminToken();
  return safeEqual(token, expected) || adminTokens.has(token);
}

function isAdminSocket(socketId) {
  return adminSockets.has(socketId);
}

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
    videoId: '60ItHLz5WEA',
    videoTitle: 'Alan Walker - Faded',
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
    chatHistory: [],
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
      chatHistory: [],
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

function broadcastChatMessage(room, chatPayload) {
  if (!room.chatHistory) room.chatHistory = [];
  room.chatHistory.push(chatPayload);
  if (room.chatHistory.length > 60) room.chatHistory.shift();
  io.to(room.roomId).emit('chat-message', chatPayload);
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
    chatHistory: room.chatHistory || [],
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

    // Nếu Admin rời rạp: chuyển hostId cho Admin khác còn trong rạp (nếu có).
    // KHÔNG tự động phong Admin cho khán giả thường.
    if (socket.id === room.hostId) {
      const nextAdmin = Array.from(room.users.values()).find((u) => u.isAdmin);
      room.hostId = nextAdmin ? nextAdmin.socketId : null;
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

  // Helper: cho socket vào một rạp (dùng chung cho join-room & switch-room)
  function enterRoom(roomId, { nickname, avatarColor, gender, seatId, adminToken } = {}) {
    leaveCurrentRoom(socket);

    // Khôi phục quyền Admin nếu client gửi kèm token hợp lệ (reload trang / reconnect)
    if (adminToken && verifyAdminToken(adminToken)) {
      adminSockets.add(socket.id);
    }

    const room = getOrCreateRoom(roomId);
    socket.join(roomId);
    socketToRoom.set(socket.id, roomId);

    const isAdmin = isAdminSocket(socket.id);
    if (isAdmin) room.hostId = socket.id;

    // Khôi phục ghế ngồi nếu client đã có ghế trước đó và ghế vẫn còn trống (giữ ghế khi F5 / switch tab)
    let restoredSeatId = null;
    if (seatId && typeof seatId === 'string') {
      let isOccupied = false;
      for (const [sId, otherUser] of room.users.entries()) {
        if (sId !== socket.id && otherUser.seatId === seatId) {
          isOccupied = true;
          break;
        }
      }
      if (!isOccupied) {
        restoredSeatId = seatId;
      }
    }

    const user = {
      socketId: socket.id,
      nickname: (nickname && String(nickname).trim().substring(0, 24)) || `Khách_${socket.id.substring(0, 4)}`,
      seatId: restoredSeatId,
      avatarColor: avatarColor || AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      gender: gender || 'Nam',
      joinedAt: Date.now(),
      isAdmin,
    };
    room.users.set(socket.id, user);

    console.log(`[Cinema] ${user.nickname} (${isAdmin ? '👑 ADMIN' : 'Khán giả'}, Ghế: ${user.seatId || 'chưa chọn'}) vào [${room.name}]. Số người: ${room.users.size}`);

    socket.emit('room-state', getSerializableRoomState(room));
    socket.to(roomId).emit('user-joined', user);
    io.to(roomId).emit('users-updated', getSerializedUsers(room));
    io.emit('rooms-list', getAllRoomsSummary());
  }

  // Helper: lấy rạp hiện tại của socket
  function currentRoom() {
    const roomId = socketToRoom.get(socket.id);
    return roomId ? rooms.get(roomId) : null;
  }

  // Helper: chặn thao tác dành riêng cho Admin
  function requireAdmin(actionLabel) {
    if (isAdminSocket(socket.id)) return true;
    socket.emit('error-message', {
      message: `Chỉ Admin mới có quyền ${actionLabel}. Bạn có thể gửi yêu cầu phim vào hàng chờ nhé!`,
    });
    return false;
  }

  // 1. Client vào rạp (mặc định Rạp 01)
  socket.on('join-room', ({ roomId = 'cinema-01', ...profile } = {}) => {
    enterRoom(roomId, profile);
  });

  // 1.1 Client đổi rạp
  socket.on('switch-room', ({ newRoomId, ...profile } = {}) => {
    if (!newRoomId) return;
    enterRoom(newRoomId, profile);
  });

  // 1.A Đăng nhập Admin bằng tên + mật khẩu
  socket.on('admin-login', ({ username, password } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ok = safeEqual(String(username || '').trim(), ADMIN_USERNAME) && safeEqual(String(password || ''), ADMIN_PASSWORD);

    if (!ok) {
      console.log(`[Admin] ❌ Đăng nhập thất bại từ ${socket.id}`);
      return reply({ ok: false, message: 'Sai tên đăng nhập hoặc mật khẩu Admin.' });
    }

    const token = createAdminToken();
    adminTokens.add(token);
    adminSockets.add(socket.id);

    const room = currentRoom();
    if (room) {
      room.hostId = socket.id;
      const user = room.users.get(socket.id);
      if (user) user.isAdmin = true;
      io.to(room.roomId).emit('users-updated', getSerializedUsers(room));
      io.to(room.roomId).emit('room-state', getSerializableRoomState(room));
    }

    console.log(`[Admin] 👑 ${socket.id} đăng nhập Admin thành công`);
    reply({ ok: true, token });
  });

  // 1.B Đăng xuất Admin
  socket.on('admin-logout', ({ adminToken } = {}) => {
    adminSockets.delete(socket.id);
    if (adminToken) adminTokens.delete(adminToken);

    const room = currentRoom();
    if (room) {
      const user = room.users.get(socket.id);
      if (user) user.isAdmin = false;
      if (room.hostId === socket.id) {
        const nextAdmin = Array.from(room.users.values()).find((u) => u.isAdmin);
        room.hostId = nextAdmin ? nextAdmin.socketId : null;
      }
      io.to(room.roomId).emit('users-updated', getSerializedUsers(room));
      io.to(room.roomId).emit('room-state', getSerializableRoomState(room));
    }
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
    if (!isAdminSocket(socket.id)) {
      // Khán giả không điều khiển phim chung: gửi lại trạng thái chuẩn để đồng bộ lại
      socket.emit("room-state", getSerializableRoomState(room));
      return;
    }

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
    if (!isAdminSocket(socket.id)) {
      // Khán giả không điều khiển phim chung: gửi lại trạng thái chuẩn để đồng bộ lại
      socket.emit("room-state", getSerializableRoomState(room));
      return;
    }

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
    if (!isAdminSocket(socket.id)) {
      // Khán giả không điều khiển phim chung: gửi lại trạng thái chuẩn để đồng bộ lại
      socket.emit("room-state", getSerializableRoomState(room));
      return;
    }

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

    if (!requireAdmin("đổi phim trực tiếp")) return;
    const user = room.users.get(socket.id);

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
    broadcastChatMessage(room, {
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

    if (!requireAdmin("quản lý hàng chờ")) return;
    const user = room.users.get(socket.id);

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

  // 5.3 Claim Admin role (yêu cầu mật khẩu Admin)
  socket.on('claim-admin', ({ key } = {}) => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    const canClaim = safeEqual(String(key || ''), ADMIN_PASSWORD);
    if (canClaim) {
      adminSockets.add(socket.id);
      if (room.hostId && room.users.has(room.hostId)) {
        const prevHost = room.users.get(room.hostId);
        if (prevHost) prevHost.isAdmin = false;
      }
      room.hostId = socket.id;
      user.isAdmin = true;
      console.log(`[Admin ${room.name}] 👑 User ${user.nickname} claimed Admin role!`);
      io.to(room.roomId).emit('users-updated', getSerializedUsers(room));
      io.to(room.roomId).emit('room-state', getSerializableRoomState(room));
    } else {
      socket.emit('error-message', { message: 'Mật khẩu Admin không chính xác!' });
    }
  });

  // 6. Client selects seat
  socket.on('user-select-seat', ({ seatId, nickname, avatarColor, gender } = {}) => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    if (nickname) user.nickname = String(nickname).trim().substring(0, 24);
    if (avatarColor) user.avatarColor = avatarColor;
    if (gender) user.gender = gender;

    let isOccupied = false;
    for (const [sId, otherUser] of room.users.entries()) {
      if (sId !== socket.id && otherUser.seatId === seatId) {
        isOccupied = true;
        break;
      }
    }

    if (isOccupied) {
      console.log(`[Seat ${room.name}] Seat ${seatId} is already occupied.`);
      socket.emit('error-message', { message: `Ghế ${seatId} đã có người ngồi, vui lòng chọn ghế khác nhé!` });
      return;
    }

    user.seatId = seatId;
    console.log(`[Seat ${room.name}] User ${user.nickname} took seat ${seatId}`);
    io.to(room.roomId).emit('users-updated', getSerializedUsers(room));
    io.to(room.roomId).emit('room-state', getSerializableRoomState(room));
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
    io.to(room.roomId).emit('room-state', getSerializableRoomState(room));
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
    broadcastChatMessage(room, chatPayload);
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
    io.to(room.roomId).emit('room-state', getSerializableRoomState(room));
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
