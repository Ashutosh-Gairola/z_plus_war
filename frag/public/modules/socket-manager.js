/**
 * Socket.IO connection and events management
 */

export class SocketManager {
  constructor(namespace = "/frag") {
    const getPath = () => {
      const p = window.location.pathname;
      if (p.includes("/demo/frag")) return "/demo/frag/socket.io";
      if (p.includes("/frag")) return "/frag/socket.io";
      return "/socket.io";
    };

    this.socket = io(namespace, {
      path: getPath(),
      transports: ["websocket", "polling"],
      rememberUpgrade: true,
      upgrade: true,
    });
    this.handlers = {};
  }

  on(event, callback) {
    this.socket.on(event, callback);
  }

  emit(event, ...args) {
    this.socket.emit(event, ...args);
  }

  emitVolatile(event, ...args) {
    this.socket.volatile.emit(event, ...args);
  }

  isConnected() {
    return this.socket.connected;
  }

  disconnect() {
    this.socket.disconnect();
  }

  registerHandler(event, handler) {
    this.handlers[event] = handler;
  }

  callHandler(event, data) {
    if (this.handlers[event]) {
      this.handlers[event](data);
    }
  }
}
