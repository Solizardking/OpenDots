#!/bin/sh
set -eu
# Railway mounts its volume after image construction, so initialize ownership here.
mkdir -p /data/users /data/ows
chown -R node:node /data
exec gosu node node dist/server/server/index.js
