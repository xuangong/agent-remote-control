const installers = new Map([
  ['install.xianliao.de5.net', 'https://raw.githubusercontent.com/xuangong/agent-remote-control/main/install.sh'],
  ['wininstall.xianliao.de5.net', 'https://raw.githubusercontent.com/xuangong/agent-remote-control/main/install.ps1'],
]);

export default {
  fetch(request) {
    const url = new URL(request.url);
    const headers = {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    };
    const installerUrl = installers.get(url.hostname);
    if (!installerUrl || url.pathname !== '/') {
      return new Response(request.method === 'HEAD' ? null : 'Not found\n', { status: 404, headers });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed\n', { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
    }
    return new Response(null, { status: 302, headers: { ...headers, Location: installerUrl } });
  },
};
