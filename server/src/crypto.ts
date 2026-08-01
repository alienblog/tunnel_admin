import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM 加密文本，返回 iv.tag.ciphertext 的 base64 组合串 */
export function encryptText(masterKey: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

/** 解密 encryptText 的输出；篡改/密钥错误会抛异常 */
export function decryptText(masterKey: Buffer, payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('密文格式错误');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
