import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { RelayBridge } from './relay/RelayBridge.js';
import { Room } from './Room.js';

const MAX_ROOMS = 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly bridges = new Map<string, RelayBridge>();
  private sweepTimer: NodeJS.Timeout | null = null;

  start(): void {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const room of this.rooms.values()) room.dispose();
    for (const b of this.bridges.values()) b.dispose();
    this.rooms.clear();
    this.bridges.clear();
  }

  create(): Room | null {
    if (this.rooms.size >= MAX_ROOMS) {
      this.sweep();
      if (this.rooms.size >= MAX_ROOMS) return null;
    }
    let code: string;
    do {
      code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    } while (this.rooms.has(code));

    const room = new Room(code, randomBytes(24).toString('base64url'));
    this.rooms.set(code, room);
    // 중계 서버가 설정되어 있으면 LTE로도 받을 수 있게 연결 (인터넷이 없으면 계속 재시도)
    if (config.relayUrl) {
      room.setShare('connecting', null); // 송출 화면이 중계 연결을 기다리게 (와이파이 주소로 먼저 넘어가지 않게)
      this.bridges.set(code, new RelayBridge(config.relayUrl, room, this));
    }
    console.log(`[room] created ${code} (total ${this.rooms.size})`);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  verifyHost(room: Room, token: string | undefined): boolean {
    if (!token) return false;
    const a = Buffer.from(room.hostToken);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  sweep(now = Date.now()): void {
    for (const [code, room] of this.rooms) {
      if (room.isExpired(now)) {
        room.dispose();
        this.bridges.get(code)?.dispose();
        this.bridges.delete(code);
        this.rooms.delete(code);
        console.log(`[room] expired ${code}`);
      }
    }
  }
}
