'use strict';
/* global process, module */

const { userInfo } = module.require('node:os');

// tsx uses os.userInfo() to name its temporary directory on Windows. Managed
// execution tokens can make libuv report uv_os_get_passwd ENOMEM even when the
// machine has ample memory. Only that failed lookup receives a stable numeric
// fallback; no process identity or credential state is changed.
function installWindowsIdentityFallback({
  platform = process.platform,
  target = process,
  lookup = userInfo,
} = {}) {
  if (platform !== 'win32' || typeof target.geteuid === 'function') return;
  try {
    lookup();
  } catch (error) {
    if (error?.syscall !== 'uv_os_get_passwd') throw error;
    target.geteuid = () => 1000;
  }
}

installWindowsIdentityFallback();

module.exports = { installWindowsIdentityFallback };
