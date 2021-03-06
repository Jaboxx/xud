import assert from 'assert';
import net, { Socket } from 'net';
import { EventEmitter } from 'events';
import Host from './Host';
import SocketAddress from './SocketAddress';
import Parser, { ParserError, ParserErrorType } from './Parser';
import { Packet } from './packets';
import Logger from '../Logger';

const pubKey = `tempPK_${Math.floor(1000 + (Math.random() * 9000))}`;

enum ConnectionDirection {
  INBOUND,
  OUTBOUND,
}

type HandshakeState = {
  listenPort?: number;
  nodeKey?: string;
  xudVersion?: string;
  pairs?: any;
};

/** Represents a remote XU peer */
class Peer extends EventEmitter {
  public socketAddress!: SocketAddress;
  public direction!: ConnectionDirection;
  private host?: Host;
  private logger: Logger = Logger.p2p;
  private connected: boolean = false;
  private opened: boolean = false;
  private socket!: Socket;
  private parser: Parser = new Parser();
  private destroyed: boolean = false;
  private connectTimeout?: NodeJS.Timer;
  private connectTime: number = 0;
  private banScore: number = 0;
  private lastRecv: number = 0;
  private lastSend: number = 0;

  get id(): string {
    assert(this.socketAddress);
    return this.socketAddress.toString();
  }

  constructor() {
    super();

    this.bindParser(this.parser);
  }

  public static fromOutbound(socketAddress: SocketAddress): Peer {
    const peer = new Peer();
    peer.connect(socketAddress);
    return peer;
  }

  public static fromInbound(socket: Socket): Peer {
    const peer = new Peer();
    peer.accept(socket);
    return peer;
  }

  public getStatus = (): string => {
    if (this.connected) {
      return `Connected to peer (${this.id})`;
    } else {
      return 'Not connected';
    }
  }

  public open = async (): Promise<void> => {
    assert(!this.opened);
    this.opened = true;

    await this.initConnection();
    // TODO: handshake process here
    const handshakeState: HandshakeState = {};

    // let the pool know that this peer is ready to go
    this.emit('open', handshakeState);
  }

  public destroy = (): void => {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.connected = false;

    if (this.socket) {
      this.socket.destroy();
      delete this.socket;
    }

    this.emit('close');
  }

  public setHost = (host: Host): void => {
    this.host = host;
  }

  public sendPacket = (packet: Packet): void => {
    this.sendRaw(packet.type, packet.toRaw());
  }

  private sendRaw = (type, body) => {
    const payload = `${type} ${body}\r\n`;
    this.socket.write(payload);

    this.lastSend = Date.now();
  }

  private increaseBan = (score): boolean => {
    this.banScore += score;

    if (this.banScore >= 100) { // TODO: make configurable
      this.logger.debug(`Ban threshold exceeded (${this.id})`);
      this.emit('ban');
      return true;
    }

    return false;
  }

  private initConnection = (): Promise<void> => {
    assert(this.socket);

    if (this.connected) {
      assert(this.direction === ConnectionDirection.INBOUND);
      this.logger.debug(this.getStatus());
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (this.connectTimeout) {
          clearTimeout(this.connectTimeout);
          this.connectTimeout = undefined;
        }
        this.socket.removeListener('error', onError);
      };

      const onError = (err) => {
        cleanup();
        this.destroy();
        reject(err);
      };

      this.socket.once('connect', () => {
        this.connectTime = Date.now();
        this.connected = true;
        this.logger.debug(this.getStatus());
        this.emit('connect');

        cleanup();
        resolve();
      });

      this.socket.once('error', onError);

      this.connectTimeout = setTimeout(() => {
        this.connectTimeout = undefined;
        cleanup();
        this.destroy();
        reject(new Error('Connection timed out.'));
      }, 10000);
    });
  }

  private connect = (socketAddress: SocketAddress): void => {
    assert(!this.socket);

    const socket = net.connect(socketAddress.port, socketAddress.address);

    this.socketAddress = socketAddress;
    this.direction = ConnectionDirection.OUTBOUND;
    this.connected = false;

    this.bindSocket(socket);
  }

  private accept = (socket: Socket): void => {
    assert(!this.socket);

    this.socketAddress = SocketAddress.fromSocket(socket);
    this.direction = ConnectionDirection.INBOUND;
    this.connected = true;

    this.bindSocket(socket);
  }

  private bindSocket = (socket: Socket) => {
    assert(!this.socket);

    this.socket = socket;

    this.socket.once('error', (err) => {
      if (!this.connected) {
        return;
      }

      this.error(err);
      this.destroy();
    });

    this.socket.once('close', () => {
      this.error('Socket hangup');
      this.destroy();
    });

    this.socket.on('data', (data) => {
      this.lastRecv = Date.now();
      this.logger.debug(`Received data (${this.id}): ${data.toString()}`);
      this.parser.feed(data);
    });

    this.socket.setNoDelay(true);
  }

  private bindParser = (parser: Parser): void => {
    parser.on('packet', (packet) => {
      // handle packet in the Peer level here, if necessary.
      this.emit('packet', packet);
    });

    parser.on('error', (err: ParserError) => {
      if (this.destroyed) {
        return;
      }

      switch (err.type) {
        case ParserErrorType.UNPARSABLE_MESSAGE: {
          this.logger.warn(`Unparsable peer message: ${err.payload}`);
          this.increaseBan(10);
          break;
        }
        case ParserErrorType.UNKNOWN_PACKET_TYPE: {
          this.logger.warn(`Unknown peer message type: ${err.payload}`);
          this.increaseBan(20);
        }
      }
    });
  }

  private error = (err): void => {
    if (this.destroyed) {
      return;
    }

    // TODO: construct a proper error object
    const msg = `Socket Error (${this.id}): ${JSON.stringify(err)}`;
    this.logger.debug(msg);

    this.emit('error', { msg, err });
  }
}

export default Peer;
export { ConnectionDirection, HandshakeState };
