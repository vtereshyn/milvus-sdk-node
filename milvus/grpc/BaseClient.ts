import path from 'path';
import crypto from 'crypto';
import protobuf, { Root, Type } from 'protobufjs';
import { readFileSync } from 'fs';
import {
  Client,
  ChannelOptions,
  credentials,
  ChannelCredentials,
} from '@grpc/grpc-js';
import { Pool } from 'generic-pool';
import {
  ERROR_REASONS,
  ClientConfig,
  DEFAULT_CONNECT_TIMEOUT,
  parseTimeToken,
  ServerInfo,
  CONNECT_STATUS,
  TLS_MODE,
} from '../';

// path
const milvusProtoPath = path.resolve(
  __dirname,
  '../../proto/proto/milvus.proto'
);
const schemaProtoPath = path.resolve(
  __dirname,
  '../../proto/proto/schema.proto'
);

/**
 * Base gRPC client, setup all configuration here
 */
export class BaseClient {
  // channel pool
  public channelPool!: Pool<Client>;
  // Client ID
  public clientId: string = `${crypto.randomUUID()}`;
  // flags to indicate that if the connection is established and its state
  public connectStatus = CONNECT_STATUS.NOT_CONNECTED;
  // connection promise
  public connectPromise = Promise.resolve();
  // TLS mode, by default it is disabled
  public readonly tlsMode: TLS_MODE = TLS_MODE.DISABLED;
  // The client configuration.
  public readonly config: ClientConfig;
  // grpc options
  public readonly channelOptions: ChannelOptions;
  // server info
  public serverInfo: ServerInfo = {};
  // // The gRPC client instance.
  // public client!: Promise<Client>;
  // The timeout for connecting to the Milvus service.
  public timeout: number = DEFAULT_CONNECT_TIMEOUT;
  // The path to the Milvus protobuf file, user can define it from clientConfig
  public protoFilePath = {
    milvus: milvusProtoPath,
    schema: schemaProtoPath,
  };

  // ChannelCredentials object used for authenticating the client on the gRPC channel.
  protected creds!: ChannelCredentials;
  // global metadata, send each grpc request with it
  protected metadata: Map<string, string> = new Map<string, string>();
  // The protobuf schema.
  protected schemaProto: Root;
  // The Milvus protobuf.
  protected milvusProto: Root;
  // The milvus collection schema Type
  protected collectionSchemaType: Type;
  // The milvus field schema Type
  protected fieldSchemaType: Type;
  // milvus proto
  protected readonly protoInternalPath = {
    serviceName: 'milvus.proto.milvus.MilvusService',
    collectionSchema: 'milvus.proto.schema.CollectionSchema',
    fieldSchema: 'milvus.proto.schema.FieldSchema',
  };

  /**
   * Sets up the configuration object for the gRPC client.
   *
   * @param configOrAddress The configuration object or the Milvus address as a string.
   * @param ssl Whether to use SSL or not. Default is false.
   * @param username The username for authentication. Required if password is provided.
   * @param password The password for authentication. Required if username is provided.
   */
  constructor(
    configOrAddress: ClientConfig | string,
    ssl?: boolean,
    username?: string,
    password?: string,
    channelOptions?: ChannelOptions
  ) {
    let config: ClientConfig;

    // If a configuration object is provided, use it. Otherwise, create a new object with the provided parameters.
    if (typeof configOrAddress === 'object') {
      config = configOrAddress;
    } else {
      config = {
        address: configOrAddress,
        ssl,
        username,
        password,
        channelOptions,
      };
    }

    // Check if the Milvus address is set.
    if (!config.address) {
      throw new Error(ERROR_REASONS.MILVUS_ADDRESS_IS_REQUIRED);
    }

    // make sure these are strings.
    config.username = config.username || '';
    config.password = config.password || '';

    // overwrite ID if necessary
    if (config.id) {
      this.clientId = config.id;
    }

    // Assign the configuration object.
    this.config = config;

    // if ssl is on or starts with https, tlsMode = 1(one way auth).
    this.tlsMode =
      this.config.address.startsWith('https://') || this.config.ssl
        ? TLS_MODE.ONE_WAY
        : TLS_MODE.DISABLED;
    // if cert and private keys are available as well, tlsMode = 2(two way auth).
    this.tlsMode =
      this.config.tls && this.config.tls.rootCertPath
        ? TLS_MODE.TWO_WAY
        : this.tlsMode;

    // setup proto file path
    if (this.config.protoFilePath) {
      const { milvus, schema } = this.config.protoFilePath;
      this.protoFilePath.milvus = milvus ?? this.protoFilePath.milvus;
      this.protoFilePath.schema = schema ?? this.protoFilePath.schema;
    }

    // Load the Milvus protobuf
    this.schemaProto = protobuf.loadSync(this.protoFilePath.schema);
    this.milvusProto = protobuf.loadSync(this.protoFilePath.milvus);

    // Get the CollectionSchemaType and FieldSchemaType from the schemaProto object.
    this.collectionSchemaType = this.schemaProto.lookupType(
      this.protoInternalPath.collectionSchema
    );
    this.fieldSchemaType = this.schemaProto.lookupType(
      this.protoInternalPath.fieldSchema
    );

    // options
    this.channelOptions = {
      // Milvus default max_receive_message_length is 100MB, but Milvus support change max_receive_message_length .
      // So SDK should support max_receive_message_length unlimited.
      'grpc.max_receive_message_length': -1, // set max_receive_message_length to unlimited
      'grpc.max_send_message_length': -1, // set max_send_message_length to unlimited
      'grpc.keepalive_time_ms': 10 * 1000, // Send keepalive pings every 10 seconds, default is 2 hours.
      'grpc.keepalive_timeout_ms': 5 * 1000, // Keepalive ping timeout after 5 seconds, default is 20 seconds.
      'grpc.keepalive_permit_without_calls': 1, // Allow keepalive pings when there are no gRPC calls.
      'grpc.enable_retries': 1, // enable retry
      ...this.config.channelOptions,
    };

    // overwrite if server name is provided.
    if (this.config.tls?.serverName) {
      this.channelOptions[`grpc.ssl_target_name_override`] =
        this.config.tls.serverName;
    }

    // Switch based on the TLS mode
    switch (this.tlsMode) {
      case TLS_MODE.ONE_WAY:
        // Create SSL credentials with empty parameters for one-way authentication
        this.creds = credentials.createSsl();
        break;
      case TLS_MODE.TWO_WAY:
        // Extract paths for root certificate, private key, certificate chain, and verify options from the client configuration
        const { rootCertPath, privateKeyPath, certChainPath, verifyOptions } =
          this.config.tls!;

        // Initialize buffers for root certificate, private key, and certificate chain
        let rootCertBuff: Buffer | null = null;
        let privateKeyBuff: Buffer | null = null;
        let certChainBuff: Buffer | null = null;

        // Read root certificate file if path is provided
        if (rootCertPath) {
          rootCertBuff = readFileSync(rootCertPath);
        }

        // Read private key file if path is provided
        if (privateKeyPath) {
          privateKeyBuff = readFileSync(privateKeyPath);
        }

        // Read certificate chain file if path is provided
        if (certChainPath) {
          certChainBuff = readFileSync(certChainPath);
        }

        // Create SSL credentials with the read files and verify options for two-way authentication
        this.creds = credentials.createSsl(
          rootCertBuff,
          privateKeyBuff,
          certChainBuff,
          verifyOptions
        );
        break;
      default:
        // Create insecure credentials if no TLS mode is specified
        this.creds = credentials.createInsecure();
        break;
    }

    // Set up the timeout for connecting to the Milvus service.
    this.timeout =
      typeof config.timeout === 'string'
        ? parseTimeToken(config.timeout)
        : config.timeout || DEFAULT_CONNECT_TIMEOUT;
  }

  /**
   * Checks the compatibility of the SDK with the Milvus server.
   *
   * @param {Object} data - Optional data object.
   * @param {string} data.message - The error message to throw if the SDK is incompatible.
   * @param {Function} data.checker - A function to call if the SDK is compatible.
   * @throws {Error} If the SDK is incompatible with the server.
   */
  async checkCompatibility(
    data: { message?: string; checker?: Function } = {}
  ) {
    // wait until connecting finished
    await this.connectPromise;

    // if the connect command is successful and nothing returned
    // we need to check the compatibility for older milvus
    if (this.connectStatus === CONNECT_STATUS.UNIMPLEMENTED) {
      // if checker available, use checker instead
      if (data.checker) {
        return data.checker();
      }

      throw new Error(
        data.message ||
          `This version of sdk is incompatible with the server, please downgrade your sdk or upgrade your server.`
      );
    }
  }
}
