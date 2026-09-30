#pragma once

// A crash saves a core dump to the `coredump` flash partition. At boot, this logs the one
// left by the last crash (task, PC, backtrace) so it shows up without a debugger;
// `make coredump` prints the full dump and clears it.
void crash_report(void);
