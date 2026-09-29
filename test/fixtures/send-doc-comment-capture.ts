import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { existsSync, writeFileSync } from 'node:fs';

(defaultHttpInstance as any).defaults.adapter = async (config: any) => {
  const url = new URL(config.url, 'https://open.feishu.cn');
  const method = String(config.method).toUpperCase();
  let data;
  if (url.pathname.includes('/auth/')) {
    data = { code: 0, tenant_access_token: 'test-token', expire: 7200 };
  } else if (url.pathname.includes('/drive/v1/files/') && url.pathname.endsWith('/replies')) {
    console.log('CAPTURE_DOC_REPLY=' + JSON.stringify({ method, path: url.pathname }));
    const rejectOnceMarker = process.env.BOTMUX_TEST_DOC_REJECT_ONCE;
    if (rejectOnceMarker && !existsSync(rejectOnceMarker)) {
      writeFileSync(rejectOnceMarker, 'rejected');
      data = { code: 99991663, msg: 'invalid parameter' };
    } else {
      data = { code: 0, data: { reply_id: 'reply_test' } };
    }
  } else {
    throw new Error(`Unexpected test HTTP request: ${method} ${url.pathname}`);
  }
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};

globalThis.fetch = async () => { throw new Error('Unexpected test fetch'); };
process.argv = [process.execPath, './src/cli.ts', ...process.argv.slice(2)];
await import('../../src/cli.js');
