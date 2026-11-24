// HTTPS 前置代理用的自签证书：首次生成并缓存。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generate } from 'selfsigned'

export const DEFAULT_CERT_DIR = path.join(os.homedir(), '.lhkit', 'certs')

/**
 * @param {string} [dir]
 * @returns {Promise<{key: string, cert: string}>}
 */
export async function ensureCert(dir = DEFAULT_CERT_DIR) {
  const keyFile = path.join(dir, 'localhost-key.pem')
  const certFile = path.join(dir, 'localhost-cert.pem')
  try {
    return { key: await fs.readFile(keyFile, 'utf8'), cert: await fs.readFile(certFile, 'utf8') }
  } catch {
    // 还没有，生成一份
  }
  const now = new Date()
  const pems = await generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate: now,
    notAfterDate: new Date(now.getTime() + 825 * 24 * 3600 * 1000),
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }],
  })
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(keyFile, pems.private, { mode: 0o600 })
  await fs.writeFile(certFile, pems.cert)
  return { key: pems.private, cert: pems.cert }
}
