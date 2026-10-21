//! forkpty, outer raw mode, SIGWINCH resize, job control (SIGTSTP/SIGCONT to
//! the PTY process group; r10: only the launcher PID got SIGCONT at first).

use std::ffi::{CStr, CString};
use std::io::{self, ErrorKind};
use std::ptr;

use libc::{self, c_int, pid_t};

pub struct Pty {
    pub master: c_int,
    pub child: pid_t,
    old: Option<libc::termios>,
    raw: libc::termios,
}

pub fn winsize() -> libc::winsize {
    unsafe {
        let mut w: libc::winsize = std::mem::zeroed();
        if libc::ioctl(0, libc::TIOCGWINSZ, &mut w) < 0 || w.ws_col == 0 {
            w.ws_row = 40;
            w.ws_col = 100;
        }
        w
    }
}

impl Pty {
    /// Fork the stock binary in a PTY. `argv[0]` is the binary path.
    pub fn spawn(bin: &CStr, args: &[CString], ws: libc::winsize) -> io::Result<Self> {
        unsafe {
            let mut ptrs: Vec<*const libc::c_char> = Vec::with_capacity(args.len() + 2);
            ptrs.push(bin.as_ptr());
            for a in args {
                ptrs.push(a.as_ptr());
            }
            ptrs.push(ptr::null());

            let mut old: libc::termios = std::mem::zeroed();
            let tty = libc::tcgetattr(0, &mut old) == 0;
            let mut raw = old;
            libc::cfmakeraw(&mut raw);

            let mut master = 0;
            let mut ws = ws;
            let pid = libc::forkpty(&mut master, ptr::null_mut(), ptr::null_mut(), &mut ws);
            if pid < 0 {
                return Err(io::Error::last_os_error());
            }
            if pid == 0 {
                libc::execvp(bin.as_ptr(), ptrs.as_ptr());
                libc::_exit(127);
            }
            if tty {
                libc::tcsetattr(0, libc::TCSANOW, &raw);
            }
            Ok(Pty {
                master,
                child: pid,
                old: tty.then_some(old),
                raw,
            })
        }
    }

    pub fn resize(&self, ws: libc::winsize) {
        unsafe {
            libc::ioctl(self.master, libc::TIOCSWINSZ, &ws);
        }
    }

    pub fn continue_group(&self) {
        unsafe {
            libc::kill(-self.child, libc::SIGCONT);
        }
        if self.old.is_some() {
            unsafe {
                libc::tcsetattr(0, libc::TCSANOW, &self.raw);
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
            unsafe {
                libc::tcsetattr(0, libc::TCSANOW, &self.raw);
            }
        }
    }

    pub fn signal_group(&self, sig: c_int) {
        unsafe {
            libc::kill(-self.child, sig);
        }
    }

    pub fn suspend_self(&self) {
        if let Some(old) = &self.old {
            unsafe {
                libc::tcsetattr(0, libc::TCSANOW, old);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
        unsafe {
            libc::raise(libc::SIGTSTP);
        }
    }

    pub fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let n = unsafe { libc::read(self.master, buf.as_mut_ptr().cast(), buf.len()) };
        if n > 0 {
            Ok(n as usize)
        } else if n == 0 {
            Ok(0)
        } else {
            let err = io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::EIO) {
                Ok(0)
            } else {
                Err(err)
            }
        }
    }

    pub fn write(&self, data: &[u8]) {
        write_all(self.master, data);
    }

    /// Close the master before a bounded wait (the plan's PTY rule).
    pub fn close_and_wait(&mut self) -> i32 {
        unsafe {
            libc::close(self.master);
            self.master = -1;
            libc::kill(-self.child, libc::SIGTERM);
            let mut status = 0;
            libc::waitpid(self.child, &mut status, 0);
            if let Some(old) = &self.old {
                libc::tcsetattr(0, libc::TCSANOW, old);
            }
            write_all(1, b"\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b[?25h");
            if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else {
                128 + libc::WTERMSIG(status)
            }
        }
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        if self.master >= 0 {
            let _ = self.close_and_wait();
        }
    }
}

pub fn write_all(fd: i32, mut data: &[u8]) {
    if fd < 0 {
        return;
    }
    while !data.is_empty() {
        let n = unsafe { libc::write(fd, data.as_ptr().cast(), data.len()) };
        if n > 0 {
            data = &data[n as usize..];
        } else if io::Error::last_os_error().kind() != ErrorKind::Interrupted {
            break;
        }
    }
}

pub fn poll_two(stdin_open: bool, master: i32, timeout_ms: i32) -> (bool, bool) {
    unsafe {
        let mut p = [
            libc::pollfd {
                fd: if stdin_open { 0 } else { -1 },
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: master,
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        libc::poll(p.as_mut_ptr(), 2, timeout_ms);
        (
            p[0].revents & libc::POLLIN != 0,
            p[1].revents & (libc::POLLIN | libc::POLLHUP) != 0,
        )
    }
}

pub fn read_stdin(buf: &mut [u8]) -> io::Result<usize> {
    let n = unsafe { libc::read(0, buf.as_mut_ptr().cast(), buf.len()) };
    if n > 0 {
        Ok(n as usize)
    } else if n == 0 {
        Ok(0)
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn wait_nonblock(pid: pid_t) -> Option<i32> {
    unsafe {
        let mut status = 0;
        if libc::waitpid(pid, &mut status, libc::WNOHANG) == pid {
            Some(status)
        } else {
            None
        }
    }
}

/// Replace this process with stock `codex`. Stdio, signals and exit code pass through.
pub fn exec_stock(bin: &CStr, args: &[CString]) -> ! {
    let mut ptrs: Vec<*const libc::c_char> = Vec::with_capacity(args.len() + 2);
    ptrs.push(bin.as_ptr());
    for a in args {
        ptrs.push(a.as_ptr());
    }
    ptrs.push(ptr::null());
    unsafe {
        libc::execvp(bin.as_ptr(), ptrs.as_ptr());
        let err = io::Error::last_os_error();
        eprintln!("murmo-codex: exec {}: {err}", bin.to_string_lossy());
        libc::_exit(127);
    }
}
