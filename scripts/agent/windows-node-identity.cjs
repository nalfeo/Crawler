'use strict';
/* eslint-disable @typescript-eslint/no-require-imports */
/* global process, require, module */

const { userInfo } = require('node:os');

// tsx derives its temporary-directory suffix from process.geteuid() on POSIX
// and os.userInfo().username on Windows. Some managed Windows execution tokens
// cannot resolve userInfo and libuv reports the misleading ENOMEM error. A
// numeric geteuid shim keeps tsx on its POSIX-safe branch without changing the
// process identity or credentials. Healthy Windows sessions keep normal tsx
// behavior; the shim is installed only when the lookup actually fails.
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
