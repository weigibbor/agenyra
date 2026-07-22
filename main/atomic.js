'use strict';
const fs = require('fs');

// Atomic file write: write to a temp file, then rename over the target. A crash
// or power loss mid-write leaves the ORIGINAL file intact instead of a truncated
// / half-written JSON that would corrupt the session or mission queue on restart.
// rename is atomic on POSIX and a replacing MoveFileEx on Windows.
function writeFileAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
    return;
  } catch (_) {
    // rename can transiently fail on Windows if the target is momentarily locked
    // (antivirus, a reader). Clean up the temp and fall back to a direct write so
    // the update isn't lost; if THAT throws, the caller's catch logs it.
    try { fs.unlinkSync(tmp); } catch (_) {}
    fs.writeFileSync(file, data);
  }
}

module.exports = { writeFileAtomic };
