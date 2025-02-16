/*
 * Copyright 2019 gRPC authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { EventEmitter } from 'events';
import * as http2 from 'http2';
import { Duplex, Readable, Writable } from 'stream';

import { ServiceError } from './call';
import { StatusObject } from './call-stream';
import { Status } from './constants';
import { Deserialize, Serialize } from './make-client';
import { Metadata } from './metadata';
import { StreamDecoder } from './stream-decoder';

interface DeadlineUnitIndexSignature {
  [name: string]: number;
}

const GRPC_ACCEPT_ENCODING_HEADER = 'grpc-accept-encoding';
const GRPC_ENCODING_HEADER = 'grpc-encoding';
const GRPC_MESSAGE_HEADER = 'grpc-message';
const GRPC_STATUS_HEADER = 'grpc-status';
const GRPC_TIMEOUT_HEADER = 'grpc-timeout';
const DEADLINE_REGEX = /(\d{1,8})\s*([HMSmun])/;
const deadlineUnitsToMs: DeadlineUnitIndexSignature = {
  H: 3600000,
  M: 60000,
  S: 1000,
  m: 1,
  u: 0.001,
  n: 0.000001,
};
const defaultResponseHeaders = {
  // TODO(cjihrig): Remove these encoding headers from the default response
  // once compression is integrated.
  [GRPC_ACCEPT_ENCODING_HEADER]: 'identity',
  [GRPC_ENCODING_HEADER]: 'identity',
  [http2.constants.HTTP2_HEADER_STATUS]: http2.constants.HTTP_STATUS_OK,
  [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc+proto',
};
const defaultResponseOptions = {
  waitForTrailers: true,
} as http2.ServerStreamResponseOptions;

export type ServerSurfaceCall = {
  cancelled: boolean;
  getPeer(): string;
  sendMetadata(responseMetadata: Metadata): void;
} & EventEmitter;

export type ServerUnaryCall<RequestType, ResponseType> = ServerSurfaceCall & {
  request: RequestType | null;
};
export type ServerReadableStream<
  RequestType,
  ResponseType
> = ServerSurfaceCall & Readable;
export type ServerWritableStream<
  RequestType,
  ResponseType
> = ServerSurfaceCall & Writable & { request: RequestType | null };
export type ServerDuplexStream<RequestType, ResponseType> = ServerSurfaceCall &
  Duplex;

export class ServerUnaryCallImpl<RequestType, ResponseType> extends EventEmitter
  implements ServerUnaryCall<RequestType, ResponseType> {
  cancelled: boolean;
  request: RequestType | null;

  constructor(
    private call: Http2ServerCallStream<RequestType, ResponseType>,
    public metadata: Metadata
  ) {
    super();
    this.cancelled = false;
    this.request = null;
    this.call.setupSurfaceCall(this);
  }

  getPeer(): string {
    throw new Error('not implemented yet');
  }

  sendMetadata(responseMetadata: Metadata): void {
    this.call.sendMetadata(responseMetadata);
  }
}

export class ServerReadableStreamImpl<RequestType, ResponseType>
  extends Readable
  implements ServerReadableStream<RequestType, ResponseType> {
  cancelled: boolean;

  constructor(
    private call: Http2ServerCallStream<RequestType, ResponseType>,
    public metadata: Metadata,
    public deserialize: Deserialize<RequestType>
  ) {
    super({ objectMode: true });
    this.cancelled = false;
    this.call.setupSurfaceCall(this);
    this.call.setupReadable(this);
  }

  _read(size: number) {
    this.call.resume();
  }

  getPeer(): string {
    throw new Error('not implemented yet');
  }

  sendMetadata(responseMetadata: Metadata): void {
    this.call.sendMetadata(responseMetadata);
  }
}

export class ServerWritableStreamImpl<RequestType, ResponseType>
  extends Writable
  implements ServerWritableStream<RequestType, ResponseType> {
  cancelled: boolean;
  request: RequestType | null;
  private trailingMetadata: Metadata;

  constructor(
    private call: Http2ServerCallStream<RequestType, ResponseType>,
    public metadata: Metadata,
    public serialize: Serialize<ResponseType>
  ) {
    super({ objectMode: true });
    this.cancelled = false;
    this.request = null;
    this.trailingMetadata = new Metadata();
    this.call.setupSurfaceCall(this);

    this.on('error', err => {
      this.call.sendError(err as ServiceError);
      this.end();
    });
  }

  getPeer(): string {
    throw new Error('not implemented yet');
  }

  sendMetadata(responseMetadata: Metadata): void {
    this.call.sendMetadata(responseMetadata);
  }

  async _write(
    chunk: ResponseType,
    encoding: string,
    // tslint:disable-next-line:no-any
    callback: (...args: any[]) => void
  ) {
    try {
      const response = await this.call.serializeMessage(chunk);

      if (!this.call.write(response)) {
        this.call.once('drain', callback);
        return;
      }
    } catch (err) {
      err.code = Status.INTERNAL;
      this.emit('error', err);
    }

    callback();
  }

  _final(callback: Function): void {
    this.call.sendStatus({
      code: Status.OK,
      details: 'OK',
      metadata: this.trailingMetadata,
    });
    callback(null);
  }

  // tslint:disable-next-line:no-any
  end(metadata?: any) {
    if (metadata) {
      this.trailingMetadata = metadata;
    }

    super.end();
  }
}

export class ServerDuplexStreamImpl<RequestType, ResponseType> extends Duplex
  implements ServerDuplexStream<RequestType, ResponseType> {
  cancelled: boolean;
  private trailingMetadata: Metadata;

  constructor(
    private call: Http2ServerCallStream<RequestType, ResponseType>,
    public metadata: Metadata,
    public serialize: Serialize<ResponseType>,
    public deserialize: Deserialize<RequestType>
  ) {
    super({ objectMode: true });
    this.cancelled = false;
    this.trailingMetadata = new Metadata();
    this.call.setupSurfaceCall(this);
    this.call.setupReadable(this);

    this.on('error', err => {
      this.call.sendError(err as ServiceError);
      this.end();
    });
  }

  getPeer(): string {
    throw new Error('not implemented yet');
  }

  sendMetadata(responseMetadata: Metadata): void {
    this.call.sendMetadata(responseMetadata);
  }
}

ServerDuplexStreamImpl.prototype._read =
  ServerReadableStreamImpl.prototype._read;
ServerDuplexStreamImpl.prototype._write =
  ServerWritableStreamImpl.prototype._write;
ServerDuplexStreamImpl.prototype._final =
  ServerWritableStreamImpl.prototype._final;
ServerDuplexStreamImpl.prototype.end = ServerWritableStreamImpl.prototype.end;

// Unary response callback signature.
export type sendUnaryData<ResponseType> = (
  error: ServiceError | null,
  value: ResponseType | null,
  trailer?: Metadata,
  flags?: number
) => void;

// User provided handler for unary calls.
export type handleUnaryCall<RequestType, ResponseType> = (
  call: ServerUnaryCall<RequestType, ResponseType>,
  callback: sendUnaryData<ResponseType>
) => void;

// User provided handler for client streaming calls.
export type handleClientStreamingCall<RequestType, ResponseType> = (
  call: ServerReadableStream<RequestType, ResponseType>,
  callback: sendUnaryData<ResponseType>
) => void;

// User provided handler for server streaming calls.
export type handleServerStreamingCall<RequestType, ResponseType> = (
  call: ServerWritableStream<RequestType, ResponseType>
) => void;

// User provided handler for bidirectional streaming calls.
export type handleBidiStreamingCall<RequestType, ResponseType> = (
  call: ServerDuplexStream<RequestType, ResponseType>
) => void;

export type HandleCall<RequestType, ResponseType> =
  | handleUnaryCall<RequestType, ResponseType>
  | handleClientStreamingCall<RequestType, ResponseType>
  | handleServerStreamingCall<RequestType, ResponseType>
  | handleBidiStreamingCall<RequestType, ResponseType>;

export interface UnaryHandler<RequestType, ResponseType> {
  func: handleUnaryCall<RequestType, ResponseType>;
  serialize: Serialize<ResponseType>;
  deserialize: Deserialize<RequestType>;
  type: HandlerType;
}

export interface ClientStreamingHandler<RequestType, ResponseType> {
  func: handleClientStreamingCall<RequestType, ResponseType>;
  serialize: Serialize<ResponseType>;
  deserialize: Deserialize<RequestType>;
  type: HandlerType;
}

export interface ServerStreamingHandler<RequestType, ResponseType> {
  func: handleServerStreamingCall<RequestType, ResponseType>;
  serialize: Serialize<ResponseType>;
  deserialize: Deserialize<RequestType>;
  type: HandlerType;
}

export interface BidiStreamingHandler<RequestType, ResponseType> {
  func: handleBidiStreamingCall<RequestType, ResponseType>;
  serialize: Serialize<ResponseType>;
  deserialize: Deserialize<RequestType>;
  type: HandlerType;
}

export type Handler<RequestType, ResponseType> =
  | UnaryHandler<RequestType, ResponseType>
  | ClientStreamingHandler<RequestType, ResponseType>
  | ServerStreamingHandler<RequestType, ResponseType>
  | BidiStreamingHandler<RequestType, ResponseType>;

export type HandlerType = 'bidi' | 'clientStream' | 'serverStream' | 'unary';

const noopTimer: NodeJS.Timer = setTimeout(() => {}, 0);

// Internal class that wraps the HTTP2 request.
export class Http2ServerCallStream<
  RequestType,
  ResponseType
> extends EventEmitter {
  cancelled = false;
  deadline: NodeJS.Timer = noopTimer;
  private wantTrailers = false;
  private metadataSent = false;

  constructor(
    private stream: http2.ServerHttp2Stream,
    private handler: Handler<RequestType, ResponseType>
  ) {
    super();

    this.stream.once('error', (err: ServiceError) => {
      err.code = Status.INTERNAL;
      this.sendError(err);
    });

    this.stream.once('close', () => {
      if (this.stream.rstCode === http2.constants.NGHTTP2_CANCEL) {
        this.cancelled = true;
        this.emit('cancelled', 'cancelled');
      }
    });

    this.stream.on('drain', () => {
      this.emit('drain');
    });
  }

  sendMetadata(customMetadata?: Metadata) {
    if (this.metadataSent) {
      return;
    }

    this.metadataSent = true;
    const custom = customMetadata ? customMetadata.toHttp2Headers() : null;
    // TODO(cjihrig): Include compression headers.
    const headers = Object.assign(defaultResponseHeaders, custom);
    this.stream.respond(headers, defaultResponseOptions);
  }

  receiveMetadata(headers: http2.IncomingHttpHeaders) {
    const metadata = Metadata.fromHttp2Headers(headers);

    // TODO(cjihrig): Receive compression metadata.

    const timeoutHeader = metadata.get(GRPC_TIMEOUT_HEADER);

    if (timeoutHeader.length > 0) {
      const match = timeoutHeader[0].toString().match(DEADLINE_REGEX);

      if (match === null) {
        const err = new Error('Invalid deadline') as ServiceError;
        err.code = Status.OUT_OF_RANGE;
        this.sendError(err);
        return;
      }

      const timeout = (+match[1] * deadlineUnitsToMs[match[2]]) | 0;

      this.deadline = setTimeout(handleExpiredDeadline, timeout, this);
      metadata.remove(GRPC_TIMEOUT_HEADER);
    }

    return metadata;
  }

  receiveUnaryMessage(): Promise<RequestType> {
    return new Promise((resolve, reject) => {
      const stream = this.stream;
      const chunks: Buffer[] = [];
      let totalLength = 0;

      stream.on('data', (data: Buffer) => {
        chunks.push(data);
        totalLength += data.byteLength;
      });

      stream.once('end', async () => {
        try {
          const requestBytes = Buffer.concat(chunks, totalLength);

          resolve(await this.deserializeMessage(requestBytes));
        } catch (err) {
          err.code = Status.INTERNAL;
          this.sendError(err);
          resolve();
        }
      });
    });
  }

  serializeMessage(value: ResponseType) {
    const messageBuffer = this.handler.serialize(value);

    // TODO(cjihrig): Call compression aware serializeMessage().
    const byteLength = messageBuffer.byteLength;
    const output = Buffer.allocUnsafe(byteLength + 5);
    output.writeUInt8(0, 0);
    output.writeUInt32BE(byteLength, 1);
    messageBuffer.copy(output, 5);
    return output;
  }

  async deserializeMessage(bytes: Buffer) {
    // TODO(cjihrig): Call compression aware deserializeMessage().
    const receivedMessage = bytes.slice(5);

    return this.handler.deserialize(receivedMessage);
  }

  async sendUnaryMessage(
    err: ServiceError | null,
    value: ResponseType | null,
    metadata?: Metadata,
    flags?: number
  ) {
    if (!metadata) {
      metadata = new Metadata();
    }

    if (err) {
      err.metadata = metadata;
      this.sendError(err);
      return;
    }

    try {
      const response = await this.serializeMessage(value!);

      this.write(response);
      this.sendStatus({ code: Status.OK, details: 'OK', metadata });
    } catch (err) {
      err.code = Status.INTERNAL;
      this.sendError(err);
    }
  }

  sendStatus(statusObj: StatusObject) {
    if (this.cancelled) {
      return;
    }

    clearTimeout(this.deadline);

    if (!this.wantTrailers) {
      this.wantTrailers = true;
      this.stream.once('wantTrailers', () => {
        const trailersToSend = Object.assign(
          {
            [GRPC_STATUS_HEADER]: statusObj.code,
            [GRPC_MESSAGE_HEADER]: encodeURI(statusObj.details as string),
          },
          statusObj.metadata.toHttp2Headers()
        );

        this.stream.sendTrailers(trailersToSend);
      });
      this.sendMetadata();
      this.stream.end();
    }
  }

  sendError(error: ServiceError) {
    const status: StatusObject = {
      code: Status.UNKNOWN,
      details: error.hasOwnProperty('message')
        ? error.message
        : 'Unknown Error',
      metadata: error.hasOwnProperty('metadata')
        ? error.metadata
        : new Metadata(),
    };

    if (error.hasOwnProperty('code') && Number.isInteger(error.code)) {
      status.code = error.code;

      if (error.hasOwnProperty('details')) {
        status.details = error.details;
      }
    }

    this.sendStatus(status);
  }

  write(chunk: Buffer) {
    if (this.cancelled) {
      return;
    }

    this.sendMetadata();
    return this.stream.write(chunk);
  }

  resume() {
    this.stream.resume();
  }

  setupSurfaceCall(call: ServerSurfaceCall) {
    this.once('cancelled', reason => {
      call.cancelled = true;
      call.emit('cancelled', reason);
    });
  }

  setupReadable(
    readable:
      | ServerReadableStream<RequestType, ResponseType>
      | ServerDuplexStream<RequestType, ResponseType>
  ) {
    const decoder = new StreamDecoder();

    /* This code here is wrong but getting the client working is the priority
     * right now and I'm not going to block that on fixing what is currently
     * unused code. If multiple messages come in with a single frame, this will
     * keep calling readable.push after it has returned false, which should not
     * happen. Independent of that, deserializeMessage is asynchronous, which
     * means that incoming messages could be reordered when emitted to the
     * application. That effect will become more pronounced when compression
     * support is added and deserializeMessage takes longer by an amount of
     * time dependent on the size of the message. A system like the one in
     * call-stream.ts should be added to buffer incoming messages and
     * preserve ordering more strongly */

    this.stream.on('data', async (data: Buffer) => {
      const messages = decoder.write(data);
      for (const message of messages) {
        try {
          const deserialized = await this.deserializeMessage(message);

          if (!readable.push(deserialized)) {
            this.stream.pause();
          }
        } catch (err) {
          err.code = Status.INTERNAL;
          readable.emit('error', err);
        }
      }
    });

    this.stream.once('end', () => {
      readable.push(null);
    });
  }
}

// tslint:disable:no-any
type UntypedServerCall = Http2ServerCallStream<any, any>;

function handleExpiredDeadline(call: UntypedServerCall) {
  const err = new Error('Deadline exceeded') as ServiceError;
  err.code = Status.DEADLINE_EXCEEDED;

  call.sendError(err);
  call.cancelled = true;
  call.emit('cancelled', 'deadline');
}
