import { S3Client } from '@aws-sdk/client-s3';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { FileSystem, FileSystemProvider } from '@chunkd/fs';
import { AwsCredentialConfig, AwsCredentialProvider } from './types.js';
import { FsAwsS3 } from './fs.s3.js';

export function isPromise<T>(t: AwsCredentialProvider | Promise<T>): t is Promise<T> {
  return 'then' in t && typeof t['then'] === 'function';
}

/** Basic JSON validation of the configuration */
export function validateConfig(cfg: AwsCredentialProvider, loc: URL): AwsCredentialProvider {
  if (cfg == null) throw new Error('Unknown configuration from:' + loc);
  if (cfg.v !== 2) throw new Error('Configuration is not v2 from:' + loc);
  if (!Array.isArray(cfg.prefixes)) throw new Error('Configuration prefixes invalid from:' + loc);

  return cfg;
}

export class FsConfigFetcher {
  loc: URL;
  fs: FileSystem;

  _config?: Promise<AwsCredentialProvider>;

  constructor(loc: URL, fs: FileSystem) {
    this.loc = loc;
    this.fs = fs;
  }

  get config(): Promise<AwsCredentialProvider> {
    if (this._config != null) return this._config;
    this._config = this.fs
      .read(this.loc)
      .then((f) => JSON.parse(f.toString()))
      .then((cfg) => validateConfig(cfg, this.loc));

    return this._config;
  }

  async findCredentials(loc: URL): Promise<AwsCredentialConfig | null> {
    const href = loc.href;
    const cfg = await this.config;
    for (const credentials of cfg.prefixes) {
      if (href.startsWith(credentials.prefix)) return credentials;
    }
    return null;
  }
}

export type AwsCredentialProviderLoader = () => Promise<AwsCredentialProvider>;
export class AwsS3CredentialProvider implements FileSystemProvider<FsAwsS3> {
  /**
   * The default session duration if none is provided by the configuration
   * By default AWS uses 3600 seconds (1 hour)
   *
   * @default 3600 seconds
   */
  defaultSessionDuration: number | undefined;
  configs: (AwsCredentialConfig | FsConfigFetcher)[] = [];

  fileSystems: Map<string, FsAwsS3> = new Map();

  /** Given a config create a file system */
  createFileSystem(cs: AwsCredentialConfig): FsAwsS3 {
    const client = new S3Client({
      credentials: fromTemporaryCredentials({
        params: {
          RoleArn: cs.roleArn,
          ExternalId: cs.externalId,
          RoleSessionName: this.createRoleSessionName(),
          DurationSeconds: cs.roleSessionDuration ?? this.defaultSessionDuration,
        },
      }),
    });

    return new FsAwsS3(client);
  }
  /** Version for session name generally v2 or v3 for aws-sdk versions */
  version = 'v3';

  /** Create a random new roleSessionName */
  createRoleSessionName(): string {
    return `fsa-${this.version}-${Date.now()}-${Math.random().toString(32).slice(2)}`;
  }

  /** Optional callback when file systems are created */
  onFileSystemCreated?: (acc: AwsCredentialConfig, fs: FileSystem) => void;

  /**
   * Register a credential configuration to be used
   * 
   * @param cfg Credential information
   *
   * @example
   * ```typescript

   * // Add a hard coded credential configuration
   * register({ prefix: 's3://foo/bar', roleArn: 'aws:iam::...:role/internal-user-read'})
   * ```
   */
  register(f: Omit<AwsCredentialConfig, 'type'>): void {
    this.configs.push({ ...f, type: 's3' });
  }

  /**
   * Load a credential configuration file from disk
   *
   * @param loc location to configuration file
   *
   * @see {@link AwsCredentialProvider}
   *
   * @example
   * ```typescript
   * registerConfig('s3://foo/bar/config.json', fsa);
   * ```
   */
  registerConfig(loc: URL, fs: FileSystem): void {
    this.configs.push(new FsConfigFetcher(loc, fs));
  }

  /** Look up the credentials for a path */
  async findCredentials(loc: URL): Promise<AwsCredentialConfig | null> {
    const href = loc.href;
    for (const cfg of this.configs) {
      if ('findCredentials' in cfg) {
        const credentials = await cfg.findCredentials(loc);
        if (credentials) return credentials;
      } else if (href.startsWith(cfg.prefix)) {
        return cfg;
      }
    }
    return null;
  }

  async find(path: URL): Promise<FsAwsS3 | null> {
    const cs = await this.findCredentials(path);
    if (cs == null) return null;

    const cacheKey = `${cs.roleArn}__${cs.externalId}__${cs.roleSessionDuration}`;
    let existing = this.fileSystems.get(cacheKey);
    if (existing == null) {
      existing = this.createFileSystem(cs);
      this.fileSystems.set(cacheKey, existing);
      this.onFileSystemCreated?.(cs, existing);
    }

    return existing;
  }
}
