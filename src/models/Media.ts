import mongoose, { Document, Schema } from 'mongoose';

// Images stored in the database so uploads persist on any deployment without external object storage.
// Referenced from other documents as `media:<id>` (see utils/mediaKey.ts).
export enum MediaPurpose {
  TEMPLATE = 'TEMPLATE',
  EVENT_LOGO = 'EVENT_LOGO',
  ORGANIZATION_LOGO = 'ORGANIZATION_LOGO',
  AVATAR = 'AVATAR'
}

export interface IMedia extends Document {
  ownerId: mongoose.Types.ObjectId;
  purpose: MediaPurpose;
  contentType: string;
  size: number;
  width?: number;
  height?: number;
  originalName?: string;
  /** the image bytes: here for images kept in the database; absent when `storage` is DISK */
  data?: Buffer;
  /** DB = bytes in this record; DISK = bytes in a file named `fileName` inside MEDIA_DIR */
  storage: 'DB' | 'DISK';
  fileName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const MediaSchema = new Schema<IMedia>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: Object.values(MediaPurpose), required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    width: { type: Number },
    height: { type: Number },
    originalName: { type: String },
    storage: { type: String, enum: ['DB', 'DISK'], default: 'DB' },
    fileName: { type: String },
    data: { type: Buffer, required: function (this: { storage?: string }) { return this.storage !== 'DISK'; }, select: false }
  },
  { timestamps: true }
);

MediaSchema.index({ ownerId: 1, purpose: 1 });

export const Media = mongoose.model<IMedia>('Media', MediaSchema);
