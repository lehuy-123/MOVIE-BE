# 📡 Cinema 3D - Backend (WebSocket Server)

Server xử lý đồng bộ thời gian thực cho rạp phim 3D bằng Socket.io và Node.js.

## 🚀 Khởi chạy cục bộ (Local Development)

1. Cài đặt thư viện:
```bash
npm install
```

2. Tạo file cấu hình môi trường `.env`:
```bash
cp .env.example .env
```

3. Khởi chạy server:
```bash
npm run dev
# hoặc chạy thông thường:
npm start
```
Server sẽ chạy tại `http://localhost:3001` với WebSocket endpoint `ws://localhost:3001` và Health check `http://localhost:3001/health`.

---

## 🚢 Hướng dẫn Deploy Backend

> [!NOTE]
> Backend sử dụng **WebSockets kết nối liên tục (persistent connections)**, do đó không thể deploy lên Vercel Serverless. Thay vào đó, hãy deploy lên các nền tảng hỗ trợ Docker/Node Container như **Render (Free)**, **Railway**, **Fly.io**, hoặc **VPS**.

### 1. Render (Khuyên dùng - Có gói Free)
1. Đăng ký/Đăng nhập [render.com](https://render.com).
2. Chọn **New +** -> **Web Service**.
3. Kết nối với GitHub repository `MOVIE-BE`.
4. Cấu hình:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Environment Variables**:
     - `PORT`: `10000` (Render sẽ cấp cổng tự động hoặc bạn dùng PORT)
     - `CORS_ORIGIN`: `https://<ten-fe-cua-ban>.vercel.app` (hoặc `*`)
5. Sau khi deploy thành công, sao chép URL Render (ví dụ: `https://movie-cinema-be.onrender.com`) để dán vào biến `NEXT_PUBLIC_SOCKET_URL` của Frontend!

### 2. Railway
1. Truy cập [railway.app](https://railway.app) -> **New Project** -> **Deploy from GitHub repo**.
2. Chọn repository `MOVIE-BE`.
3. Railway sẽ tự động phát hiện `package.json` hoặc `Dockerfile` và deploy!
