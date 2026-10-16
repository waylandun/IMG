import tls from 'node:tls';

// Electron's roots can differ from the Node CLI's. Retain bundled/extra roots
// and add OS trust; hostname checks and certificate verification stay enabled.
export function configureCertificateTrust(provider = tls) {
  if (!provider.getCACertificates || !provider.setDefaultCACertificates) return false;
  const certificates = [...new Set([...provider.getCACertificates('default'), ...provider.getCACertificates('system')])];
  provider.setDefaultCACertificates(certificates);
  return true;
}

export function connectionErrorMessage(error) {
  const codes = new Set();
  const visit = (item, depth = 0) => {
    if (!item || depth > 5) return;
    if (typeof item.code === 'string') codes.add(item.code);
    visit(item.cause, depth + 1);
    if (Array.isArray(item.errors)) item.errors.forEach(child => visit(child, depth + 1));
  };
  visit(error);
  if ([...codes].some(code => /CERT|ISSUER|SIGNATURE|SELF_SIGNED/.test(code))) return '网关 HTTPS 证书验证失败，请检查证书链或系统信任设置。';
  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) return '无法解析网关域名，请检查网络和 base_url。';
  if (codes.has('ECONNREFUSED')) return '网关拒绝连接，请检查服务是否运行，以及 base_url 的端口。';
  if (error?.name === 'TimeoutError' || codes.has('ETIMEDOUT') || codes.has('UND_ERR_CONNECT_TIMEOUT')) return '连接网关超时，请检查网络或代理设置。';
  return '无法连接当前网关，请检查网络、代理和 base_url。';
}

configureCertificateTrust();
