import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Requests } from '@chunkd/source-aws';
import { PassThrough, Readable } from 'stream';

function streamToBuffer(stream?: Readable): Promise<Buffer | undefined> {
  if (stream == null) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** One megabyte in bytes */
const OneMegaByte = 1024 * 1204;

/**
 * Wrapper around the v3 SDK to make it compatible with the existing logic
 *
 * Once v3 SDK becomes more common place the S3Like API can be switched to the v3 version
 */
export class S3LikeV3 implements Requests.S3Like {
  /** Concurrency for uploads */
  uploadQueueSize = 4;
  /** Number of bytes to split uploads on */
  uploadPartSize = 10 * OneMegaByte;

  client: S3Client;
  constructor(client: S3Client) {
    this.client = client;
  }

  getObject(req: Requests.GetObjectReq): Requests.S3LikeResponseStream<Requests.GetObjectRes> {
    const client = this.client;
    const cmd = new GetObjectCommand(req);
    return {
      async promise(): Promise<{ Body?: Buffer | unknown; ContentRange?: string }> {
        const res = await client.send(cmd);
        return {
          ...res,
          /** Old api had the Body as a buffer, now its a readable, convert it to a buffer first */
          Body: await streamToBuffer(res.Body as Readable),
        };
      },
      createReadStream(): Readable {
        /** Old api was synchronous, the v3 sdk uses a await before the body is a readable */
        const pt = new PassThrough();
        client
          .send(cmd)
          .then((r) => {
            if (r.Body) (r.Body as Readable).pipe(pt);
            else pt.end();
          })
          .catch((e) => pt.emit('error', e));
        return pt;
      },
    };
  }

  deleteObject(req: Requests.Location): Requests.S3LikeResponse<Requests.DeleteObjectRes> {
    return this.client.send(new DeleteObjectCommand(req));
  }
  headObject(req: Requests.Location): Promise<Requests.HeadRes> {
    return this.client.send(new HeadObjectCommand(req));
  }
  listObjectsV2(req: Requests.ListReq): Promise<Requests.ListRes> {
    return this.client.send(new ListObjectsV2Command(req));
  }
  upload(req: Requests.UploadReq): Promise<unknown> {
    return new Upload({
      client: this.client,
      queueSize: this.uploadQueueSize,
      partSize: this.uploadPartSize,
      params: req,
    }).done();
  }
}
