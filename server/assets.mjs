import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ProviderError } from './provider.mjs';

export const ASSET_LIMIT = 20 * 1024 * 1024;
export const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const options = { limitInputPixels: 25_000_000, animated: false };

export class Assets {
  constructor(directory) { this.directory = path.join(directory, 'assets'); }
  async init() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  async get(id) {
    if (!validId(id)) throw new ProviderError('图片标识无效。', 400);
    try { return JSON.parse(await readFile(path.join(this.directory, `${id}.json`), 'utf8')); }
    catch { throw new ProviderError('参考图不存在，请重新上传。', 404); }
  }
  async bytes(id) {
    const asset = await this.get(id);
    return { ...asset, bytes: await readFile(path.join(this.directory, `${id}.${asset.format}`)) };
  }
  async save(bytes, { name = '图片', mask = false, format, compression = 90 } = {}) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > ASSET_LIMIT) throw new ProviderError('每张图片不得超过 20 MB。', 413);
    let image, info;
    try {
      const meta = await sharp(bytes, options).metadata();
      if (!MIME[meta.format] || (meta.pages || 1) > 1) throw new Error();
      const target = mask ? 'png' : format || meta.format;
      const converted = await sharp(bytes, options).rotate().toFormat(target, target === 'png' ? {} : { quality: Math.max(1, compression) }).toBuffer({ resolveWithObject: true });
      image = converted.data; info = converted.info;
    } catch { throw new ProviderError('图片无法读取，仅支持静态 PNG、JPEG、WebP，最大 2500 万像素。', 400); }
    if (image.length > (mask ? 4 * 1024 * 1024 : ASSET_LIMIT)) throw new ProviderError(mask ? '选区蒙版超过 4 MB，请缩小图片。' : '处理后的图片超过 20 MB。', 413);
    const id = randomUUID();
    const { isOpaque } = await sharp(image).stats();
    const asset = { id, name: String(name).slice(0, 160), format: info.format, mime: MIME[info.format], width: info.width, height: info.height, size: image.length, transparent: !isOpaque, mask, url: `/api/assets/${id}`, createdAt: new Date().toISOString() };
    await writeFile(path.join(this.directory, `${id}.${info.format}`), image, { mode: 0o600 });
    const file = path.join(this.directory, `${id}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(asset), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    return asset;
  }
  async prepare({ type, sourceId, maskId, margins }) {
    const source = await this.bytes(sourceId);
    if (type === 'inpaint') {
      const mask = await this.bytes(maskId);
      if (!mask.mask || mask.format !== 'png' || mask.width !== source.width || mask.height !== source.height) throw new ProviderError('蒙版必须是与原图等大的 PNG。', 400);
      const raw = await sharp(mask.bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer();
      let editable = false;
      for (let i = 3; i < raw.length; i += 4) if (raw[i] < 255) { editable = true; break; }
      if (!editable) throw new ProviderError('请先涂抹或框选需要修改的区域。', 400);
      return { type, sourceId, base: await this.get(sourceId), mask: await this.get(maskId) };
    }
    if (type !== 'outpaint') throw new ProviderError('编辑类型无效。', 400);
    const edges = ['left', 'right', 'top', 'bottom'];
    if (!margins || edges.some(edge => !Number.isInteger(margins[edge]) || margins[edge] < 0 || margins[edge] > 100)) throw new ProviderError('扩图边距必须为 0–100%。', 400);
    if (!edges.some(edge => margins[edge])) throw new ProviderError('至少选择一个扩图方向。', 400);
    const pad = Object.fromEntries(edges.map(edge => [edge, Math.round((edge === 'left' || edge === 'right' ? source.width : source.height) * margins[edge] / 100 / 16) * 16]));
    let width = Math.ceil((source.width + pad.left + pad.right) / 16) * 16;
    let height = Math.ceil((source.height + pad.top + pad.bottom) / 16) * 16;
    if (width > 3840 || height > 3840 || width * height > 8_294_400 || Math.max(width / height, height / width) > 3) throw new ProviderError('扩图画布过大或比例超过 3:1，请缩小边距。', 400);
    pad.right = width - source.width - pad.left; pad.bottom = height - source.height - pad.top;
    const expanded = await sharp(source.bytes).ensureAlpha().extend({ ...pad, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const maskBytes = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: source.width, height: source.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer(), left: pad.left, top: pad.top }]).png().toBuffer();
    const base = await this.save(expanded, { name: '扩图画布', format: 'png' });
    const mask = await this.save(maskBytes, { name: '扩图选区', mask: true });
    return { type, sourceId, base, mask, margins, size: width * height >= 655_360 ? `${width}x${height}` : 'auto' };
  }
  async preserveOutside(generated, baseId, maskId) {
    const [base, mask] = await Promise.all([this.bytes(baseId), this.bytes(maskId)]);
    const [original, selection, edited] = await Promise.all([
      sharp(base.bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer(),
      sharp(mask.bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer(),
      sharp(generated).resize(base.width, base.height, { fit: 'fill' }).toColourspace('srgb').ensureAlpha().raw().toBuffer(),
    ]);
    for (let i = 0; i < edited.length; i += 4) {
      const keep = selection[i + 3] / 255;
      for (let c = 0; c < 4; c++) edited[i + c] = Math.round(original[i + c] * keep + edited[i + c] * (1 - keep));
    }
    return sharp(edited, { raw: { width: base.width, height: base.height, channels: 4 } }).png().toBuffer();
  }
  async visionImage(id) {
    const asset = await this.bytes(id);
    const bytes = await sharp(asset.bytes).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    return `data:image/png;base64,${bytes.toString('base64')}`;
  }
}
