import { EventEmitter } from 'events';
import { Client, QueryResult } from 'pg';
import { StrictEventEmitter } from 'strict-event-emitter-types';
import { v4 } from 'uuid';

export interface PoolOptionsBase {
  /**
   * Number of connections to store in the pool
   */
  poolSize: number;
  /**
   * Milliseconds until an idle connection is closed and removed from the active connection pool
   */
  idleTimeoutMillis: number;
  /**
   * Milliseconds to wait for an available connection before throwing an error that no connection is available
   */
  waitForAvailableConnectionTimeoutMillis: number;
  /**
   * Milliseconds to wait to connect to postgres
   */
  connectionTimeoutMillis: number;
  /**
   * If connect should be retried when the database throws "the database system is starting up"
   * NOTE: This typically happens during a fail over scenario when a read-replica is being promoted to master
   */
  reconnectOnDatabaseIsStartingError: boolean;
  /**
   * Milliseconds to wait between retry connection attempts while the database is starting up. Allows you to throttle
   * how many retries should happen until databaseStartupTimeoutMillis expires. A value of 0 will
   * retry the query immediately.
   */
  waitForDatabaseStartupMillis: number;
  /**
   * If connection attempts continually return "the database system is starting up", this is the total number of milliseconds
   * to wait until an error is thrown.
   */
  databaseStartupTimeoutMillis: number;
  /**
   * If the query should be retried when the database throws "cannot execute X in a read-only transaction"
   * NOTE: This typically happens during a fail over scenario when a read-replica is being promoted to master
   */
  reconnectOnReadOnlyTransactionError: boolean;
  /**
   * Milliseconds to wait between retry queries while the connection is marked as read-only. Allows you to throttle
   * how many retries should happen until readOnlyTransactionReconnectTimeoutMillis expires. A value of 0 will
   * try reconnecting immediately.
   */
  waitForReconnectReadOnlyTransactionMillis: number;
  /**
   * If queries continually return "cannot execute X in a read-only transaction", this is the total number of
   * milliseconds to wait until an error is thrown.
   */
  readOnlyTransactionReconnectTimeoutMillis: number;
}

export interface PoolOptionsExplicit {
  host: string;
  database: string;
  user?: string;
  password?: string;
  port?: number;
  poolSize?: number;
  idleTimeoutMillis?: number;
  waitForAvailableConnectionTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  reconnectOnDatabaseIsStartingError?: boolean;
  waitForDatabaseStartupMillis?: number;
  databaseStartupTimeoutMillis?: number;
  reconnectOnReadOnlyTransactionError?: boolean;
  waitForReconnectReadOnlyTransactionMillis?: number;
  readOnlyTransactionReconnectTimeoutMillis?: number;
}

export interface PoolOptionsImplicit {
  connectionString: string;
  poolSize?: number;
  idleTimeoutMillis?: number;
  waitForAvailableConnectionTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  reconnectOnDatabaseIsStartingError?: boolean;
  waitForDatabaseStartupMillis?: number;
  databaseStartupTimeoutMillis?: number;
  reconnectOnReadOnlyTransactionError?: boolean;
  waitForReconnectReadOnlyTransactionMillis?: number;
  readOnlyTransactionReconnectTimeoutMillis?: number;
}

export type PoolClient = Client & {
  uniqueId: string;
  idleTimeoutTimer?: NodeJS.Timer;
  release: (removeConnection?: boolean) => void;
  errorHandler: (err: Error) => void;
};

interface PoolEvents {
  connectionRequestQueued: () => void;
  connectionRequestDequeued: () => void;
  connectionAddedToPool: () => void;
  connectionRemovedFromPool: () => void;
  connectionIdle: () => void;
  connectionRemovedFromIdlePool: () => void;
  idleConnectionActivated: () => void;
  queryDeniedForReadOnlyTransaction: () => void;
  waitingForDatabaseToStart: () => void;
  error: (error: Error, client?: PoolClient) => void;
}

type PoolEmitter = StrictEventEmitter<EventEmitter, PoolEvents>;

export class Pool extends (EventEmitter as { new(): PoolEmitter }) {
  /**
   * Gets the number of queued requests waiting for a database connection
   */
  get waitingCount(): number {
    return this.connectionQueue.length;
  }

  /**
   * Gets the number of idle connections
   */
  get idleCount(): number {
    return this.idleConnections.length;
  }

  /**
   * Gets the total number of connections in the pool
   */
  get totalCount(): number {
    return this.connections.length;
  }
  protected options: PoolOptionsBase & (PoolOptionsExplicit | PoolOptionsImplicit);
  // Internal event emitter used to handle queued connection requests
  protected connectionQueueEventEmitter: EventEmitter;
  protected connections: string[] = [];
  // Should self order by idle timeout ascending
  protected idleConnections: PoolClient[] = [];
  protected connectionQueue: string[] = [];
  protected isEnding: boolean = false;

  constructor (options: PoolOptionsExplicit | PoolOptionsImplicit) {
    super();

    const defaultOptions: PoolOptionsBase = {
      poolSize: 10,
      idleTimeoutMillis: 10000,
      waitForAvailableConnectionTimeoutMillis: 90000,
      connectionTimeoutMillis: 30000,
      reconnectOnDatabaseIsStartingError: true,
      waitForDatabaseStartupMillis: 0,
      databaseStartupTimeoutMillis: 90000,
      reconnectOnReadOnlyTransactionError: true,
      waitForReconnectReadOnlyTransactionMillis: 0,
      readOnlyTransactionReconnectTimeoutMillis: 90000,
    };

    this.options = Object.assign({}, defaultOptions, options);
    this.connectionQueueEventEmitter = new EventEmitter();
  }

  /**
   * Gets a client connection from the pool.
   * Note: You must call `.release()` when finished with the client connection object. That will release the connection back to the pool to be used by other requests.
   */
  public async connect(): Promise<PoolClient> {
    if (this.isEnding) {
      throw new Error('Cannot use pool after calling end() on the pool');
    }

    const idleConnection = this.idleConnections.shift();
    if (idleConnection) {
      if (idleConnection.idleTimeoutTimer) {
        clearTimeout(idleConnection.idleTimeoutTimer);
      }

      this.emit('idleConnectionActivated');

      return idleConnection;
    }

    const id = v4();

    if (this.connections.length < this.options.poolSize) {
      this.connections.push(id);

      return await this._createConnection(id);
    }

    this.emit('connectionRequestQueued');
    this.connectionQueue.push(id);
    let connectionTimeoutTimer;
    try {
      return await Promise.race([
        new Promise((resolve) => {
          this.connectionQueueEventEmitter.on(`connection_${id}`, (client: Client) => {
            this.connectionQueueEventEmitter.removeAllListeners(`connection_${id}`);

            this.emit('connectionRequestDequeued');
            resolve(client);
          });
        }),
        new Promise((_, reject) => {
          connectionTimeoutTimer = setTimeout(() => {
            this.connectionQueueEventEmitter.removeAllListeners(`connection_${id}`);

            const index = this.connectionQueue.indexOf(id);
            if (index > -1) {
              this.connectionQueue.splice(index, 1);
            }

            reject(new Error('Timed out while waiting for available connection in pool'));
          }, this.options.waitForAvailableConnectionTimeoutMillis);
        }),
      ]) as PoolClient;
    } finally {
      if (connectionTimeoutTimer) {
        clearTimeout(connectionTimeoutTimer);
      }
    }
  }

  /**
   * Gets a connection to the database and executes the specified query. This method will release the connection back to the pool when the query has finished.
   * @param {string} text
   * @param {Array} values
   */
  public async query(text: string, values?: any[]): Promise<QueryResult> {
    return this._query(text, values);
  }

  /**
   * Drains the pool of all active client connections. Used to shut down the pool down cleanly
   */
  public end() {
    this.isEnding = true;

    for (const idleConnection of this.idleConnections) {
      this._removeConnection(idleConnection);
    }
  }

  private async _query(text: string, values?: any[], readOnlyStartTime?: [number, number]): Promise<QueryResult> {
    const connection = await this.connect();
    let removeConnection = false;
    let timeoutError: Error | undefined;
    try {
      return await connection.query(text, values);
    } catch (ex) {
      if (this.options.reconnectOnReadOnlyTransactionError && /cannot execute [\s\w]+ in a read-only transaction/igu.test(ex.message)) {
        timeoutError = ex;
        removeConnection = true;
      } else {
        throw ex;
      }
    } finally {
      connection.release(removeConnection);
    }

    // If we get here, that means that the query was attempted with a read-only connection.
    // This can happen when the cluster fails over to a read-replica
    this.emit('queryDeniedForReadOnlyTransaction');

    // Clear all idle connections and try the query again with a fresh connection
    for (const idleConnection of this.idleConnections) {
      // tslint:disable-next-line:no-parameter-reassignment
      this._removeConnection(idleConnection);
    }

    if (!readOnlyStartTime) {
      // tslint:disable-next-line:no-parameter-reassignment
      readOnlyStartTime = process.hrtime();
    }

    if (this.options.waitForReconnectReadOnlyTransactionMillis > 0) {
      await new Promise((resolve) => {
        setTimeout(() => {
          resolve();
        }, this.options.waitForReconnectReadOnlyTransactionMillis);
      });
    }

    const diff = process.hrtime(readOnlyStartTime);
    const timeSinceLastRun = Number(((diff[0] * 1e3) + (diff[1] * 1e-6)).toFixed(3));

    if (timeSinceLastRun > this.options.readOnlyTransactionReconnectTimeoutMillis) {
      throw timeoutError;
    }

    return await this._query(text, values, readOnlyStartTime);
  }

  /**
   * Creates a new client connection to add to the pool
   * @param {string} connectionId
   * @param {[number,number]} [databaseStartupStartTime] - hrtime when the db was first listed as starting up
   */
  private async _createConnection(connectionId: string, databaseStartupStartTime?: [number, number]): Promise<PoolClient> {
    const client = new Client(this.options) as PoolClient;
    client.uniqueId = connectionId;
    /**
     * Releases the client connection back to the pool, to be used by another query.
     */
    client.release = (removeConnection: boolean = false) => {
      if (this.isEnding || removeConnection) {
        this._removeConnection(client);
        return;
      }

      const id = this.connectionQueue.shift();

      // Return the connection to be used by a queued request
      if (id) {
        this.connectionQueueEventEmitter.emit(`connection_${id}`, client);
      } else if (this.options.idleTimeoutMillis > 0) {
        client.idleTimeoutTimer = setTimeout(() => {
          this._removeConnection(client);
        }, this.options.idleTimeoutMillis);

        this.idleConnections.push(client);
        this.emit('connectionIdle');
      } else {
        this._removeConnection(client);
      }
    };

    client.errorHandler = (err: Error) => {
      this._removeConnection(client);
      this.emit('error', err, client);
    };

    client.on('error', client.errorHandler);
    let connectionTimeoutTimer;
    try {
      await Promise.race([
        client.connect(),
        new Promise((_, reject) => {
          connectionTimeoutTimer = setTimeout(() => {
            reject(new Error('Timed out trying to connect to postgres'));
          }, this.options.connectionTimeoutMillis);
        }),
      ]);

      this.emit('connectionAddedToPool');
    } catch (ex) {
      if (this.options.reconnectOnDatabaseIsStartingError && /the database system is starting up/igu.test(ex.message)) {
        this.emit('waitingForDatabaseToStart');

        if (!databaseStartupStartTime) {
          // tslint:disable-next-line:no-parameter-reassignment
          databaseStartupStartTime = process.hrtime();
        }

        if (this.options.waitForDatabaseStartupMillis > 0) {
          await new Promise((resolve) => {
            setTimeout(() => {
              resolve();
            }, this.options.waitForDatabaseStartupMillis);
          });
        }

        const diff = process.hrtime(databaseStartupStartTime);
        const timeSinceFirstConnectAttempt = Number(((diff[0] * 1e3) + (diff[1] * 1e-6)).toFixed(3));

        if (timeSinceFirstConnectAttempt > this.options.databaseStartupTimeoutMillis) {
          throw ex;
        }

        return await this._createConnection(connectionId, databaseStartupStartTime);
      } else {
        await client.end();

        throw ex;
      }
    } finally {
      if (connectionTimeoutTimer) {
        clearTimeout(connectionTimeoutTimer);
      }
    }

    return client;
  }

  /**
   * Removes the client connection from the pool and tries to gracefully shut it down
   * @param {PoolClient} client
   */
  private _removeConnection(client: PoolClient) {
    client.removeListener('error', client.errorHandler);
    // Ignore any errors when ending the connection
    // tslint:disable-next-line:no-empty
    client.on('error', () => {});

    if (client.idleTimeoutTimer) {
      clearTimeout(client.idleTimeoutTimer);
    }

    const idleConnectionIndex = this.idleConnections.findIndex((connection) => {
      return connection.uniqueId === client.uniqueId;
    });
    if (idleConnectionIndex > -1) {
      this.idleConnections.splice(idleConnectionIndex, 1);
      this.emit('connectionRemovedFromIdlePool');
    }

    const connectionIndex = this.connections.indexOf(client.uniqueId);
    if (connectionIndex > -1) {
      this.connections.splice(connectionIndex, 1);
    }

    client.end().catch((ex) => {
      if (!/This socket has been ended by the other party/igu.test(ex.message)) {
        this.emit('error', ex);
      }
    });

    this.emit('connectionRemovedFromPool');
  }
}
