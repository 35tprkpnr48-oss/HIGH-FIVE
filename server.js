const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 10000,
  pingTimeout: 20000
});
const PORT = process.env.PORT || 3000;
app.use(express.static(__dirname, { extensions: ["html"] }));

const queue = [];
const rooms = new Map();
const playerRoom = new Map();

function removeFromQueue(socketId) {
  const i = queue.findIndex(p => p.id === socketId);
  if (i >= 0) queue.splice(i, 1);
}
function leaveRoom(socket) {
  removeFromQueue(socket.id);
  const roomId = playerRoom.get(socket.id);
  if (!roomId) return;
  const room = rooms.get(roomId);
  playerRoom.delete(socket.id);
  if (room) {
    socket.to(roomId).emit("opponentLeft");
    for (const id of room.players) playerRoom.delete(id);
    rooms.delete(roomId);
  }
}
function matchPlayers() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    const sa = io.sockets.sockets.get(a.id);
    const sb = io.sockets.sockets.get(b.id);
    if (!sa || !sb || !sa.connected || !sb.connected) {
      if (sa?.connected) queue.unshift(a);
      if (sb?.connected) queue.unshift(b);
      continue;
    }
    const roomId = "race-" + a.id + "-" + b.id;
    const room = { players: [a.id, b.id], winnerId: null, finished: false, startedAt: Date.now() };
    rooms.set(roomId, room);
    playerRoom.set(a.id, roomId);
    playerRoom.set(b.id, roomId);
    sa.join(roomId); sb.join(roomId);
    sa.emit("matched", { roomId, opponentCar: b.car, lane: -1 });
    sb.emit("matched", { roomId, opponentCar: a.car, lane: 1 });
  }
}
io.on("connection", socket => {
  socket.on("joinQueue", data => {
    leaveRoom(socket);
    const car = Number.isInteger(data?.car) ? Math.max(0, Math.min(100, data.car)) : 0;
    if (!queue.some(p => p.id === socket.id)) queue.push({ id: socket.id, car });
    socket.emit("queued");
    matchPlayers();
  });
  socket.on("cancelQueue", () => leaveRoom(socket));
  socket.on("playerState", state => {
    const roomId = playerRoom.get(socket.id);
    if (!roomId || !state || !Number.isFinite(state.x) || !Number.isFinite(state.z)) return;
    socket.to(roomId).emit("opponentState", {
      x: Math.max(-10, Math.min(10, state.x)),
      z: Math.max(0, Math.min(5200, state.z)),
      speed: Math.max(0, Math.min(500, Number(state.speed) || 0)),
      yaw: Math.max(-0.5, Math.min(0.5, Number(state.yaw) || 0)),
      car: Math.max(0, Math.min(100, Number(state.car) || 0))
    });
  });
  socket.on("playerBump", () => {
    const roomId = playerRoom.get(socket.id);
    if (roomId) socket.to(roomId).emit("playerBump");
  });
  socket.on("finishRace", () => {
    const roomId = playerRoom.get(socket.id);
    const room = roomId && rooms.get(roomId);
    if (!room || room.finished || !room.players.includes(socket.id)) return;
    room.finished = true;
    room.winnerId = socket.id;
    io.to(roomId).emit("raceResult", { winnerId: socket.id, roomId });
  });
  socket.on("disconnect", () => leaveRoom(socket));
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Otoyol Sürücüsü multiplayer server: http://localhost:${PORT}`);
});
