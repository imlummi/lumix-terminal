const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow;
let powershellProcess = null;
let currentDirectory = os.homedir();
let isProcessing = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: '#0c0c0c',
    titleBarStyle: 'hidden',
    frame: false,
    minWidth: 500,
    minHeight: 350,
    title: 'Terminal'
  });

  mainWindow.loadFile('index.html');
  
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

function createPowerShellSession() {
  if (powershellProcess) {
    try {
      powershellProcess.kill('SIGTERM');
    } catch (e) {
      console.log('Process already dead');
    }
    powershellProcess = null;
  }

  // Determine the PowerShell executable
  let psCommand;
  let psArgs;
  
  if (process.platform === 'win32') {
    // Try PowerShell 7 first, fallback to Windows PowerShell
    psCommand = 'pwsh';
    psArgs = ['-NoLogo', '-NoProfile', '-Command', '-'];
    
    // Test if pwsh exists, fallback to powershell
    try {
      const testProcess = spawn('pwsh', ['--version'], { stdio: 'ignore' });
      testProcess.on('error', () => {
        psCommand = 'powershell';
        psArgs = ['-NoLogo', '-NoProfile', '-Command', '-'];
      });
    } catch (e) {
      psCommand = 'powershell';
      psArgs = ['-NoLogo', '-NoProfile', '-Command', '-'];
    }
  } else {
    // Unix-like systems (macOS, Linux)
    psCommand = 'pwsh';
    psArgs = ['-NoLogo', '-NoProfile', '-Command', '-'];
  }

  console.log(`Starting PowerShell with: ${psCommand} ${psArgs.join(' ')}`);

  try {
    powershellProcess = spawn(psCommand, psArgs, {
      cwd: currentDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });

    powershellProcess.on('error', (err) => {
      console.error('PowerShell process error:', err);
      powershellProcess = null;
    });

    powershellProcess.on('exit', (code) => {
      console.log(`PowerShell process exited with code ${code}`);
      powershellProcess = null;
    });

    // Test the connection
    return new Promise((resolve) => {
      let testOutput = '';
      const testTimeout = setTimeout(() => {
        console.log('PowerShell test timeout');
        if (powershellProcess) {
          powershellProcess.kill();
          powershellProcess = null;
        }
        resolve(false);
      }, 3000);

      const onData = (data) => {
        testOutput += data.toString();
        if (testOutput.includes('PowerShell')) {
          clearTimeout(testTimeout);
          powershellProcess.stdout.removeListener('data', onData);
          resolve(true);
        }
      };

      powershellProcess.stdout.on('data', onData);
      powershellProcess.stdin.write('Write-Host "PowerShell Ready"\n');
    });

  } catch (error) {
    console.error('Failed to spawn PowerShell:', error);
    return Promise.resolve(false);
  }
}

// Simple command execution without complex markers
ipcMain.handle('execute-powershell', async (event, command) => {
  if (isProcessing) {
    return { output: '', error: 'Another command is already running', success: false };
  }

  if (!powershellProcess) {
    const created = await createPowerShellSession();
    if (!created) {
      return { output: '', error: 'Failed to start PowerShell', success: false };
    }
  }

  isProcessing = true;

  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';
    let completed = false;

    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        cleanup();
        isProcessing = false;
        resolve({ output: output || 'Command timed out', error: 'Timeout', success: false });
      }
    }, 10000); // 10 second timeout

    const cleanup = () => {
      if (powershellProcess) {
        powershellProcess.stdout.removeAllListeners('data');
        powershellProcess.stderr.removeAllListeners('data');
      }
      clearTimeout(timeout);
    };

    const onStdout = (data) => {
      output += data.toString();
    };

    const onStderr = (data) => {
      errorOutput += data.toString();
    };

    const onError = (err) => {
      if (!completed) {
        completed = true;
        cleanup();
        isProcessing = false;
        resolve({ output: '', error: err.message, success: false });
      }
    };

    // Set up listeners
    powershellProcess.stdout.on('data', onStdout);
    powershellProcess.stderr.on('data', onStderr);
    powershellProcess.on('error', onError);

    // Execute command and wait for result
    try {
      powershellProcess.stdin.write(`${command}\n`);
      
      // Give some time for output, then resolve
      setTimeout(() => {
        if (!completed) {
          completed = true;
          cleanup();
          isProcessing = false;
          
          if (errorOutput && errorOutput.trim()) {
            resolve({ output: output.trim(), error: errorOutput.trim(), success: false });
          } else {
            resolve({ output: output.trim(), error: '', success: true });
          }
        }
      }, 1000); // Wait 1 second for output
      
    } catch (error) {
      completed = true;
      cleanup();
      isProcessing = false;
      resolve({ output: '', error: error.message, success: false });
    }
  });
});

// Alternative: Execute single commands (more reliable)
ipcMain.handle('execute-powershell-single', async (event, command) => {
  return new Promise((resolve) => {
    const psCommand = process.platform === 'win32' ? 'powershell' : 'pwsh';
    const args = ['-NoLogo', '-NoProfile', '-Command', command];

    const child = spawn(psCommand, args, {
      cwd: currentDirectory,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    child.on('close', (code) => {
      if (errorOutput && errorOutput.trim()) {
        resolve({ output: output.trim(), error: errorOutput.trim(), success: false });
      } else {
        resolve({ output: output.trim(), error: '', success: true });
      }
    });

    child.on('error', (err) => {
      resolve({ output: '', error: err.message, success: false });
    });

    // Timeout
    setTimeout(() => {
      child.kill();
      resolve({ output: '', error: 'Command timeout', success: false });
    }, 8000);
  });
});

// Get current directory
ipcMain.handle('get-current-directory', async () => {
  try {
    const result = await new Promise((resolve) => {
      const psCommand = process.platform === 'win32' ? 'powershell' : 'pwsh';
      const child = spawn(psCommand, ['-NoLogo', '-NoProfile', '-Command', 'Get-Location | Select-Object -ExpandProperty Path'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.on('close', () => {
        resolve(output.trim());
      });

      child.on('error', () => {
        resolve(currentDirectory);
      });

      setTimeout(() => {
        child.kill();
        resolve(currentDirectory);
      }, 3000);
    });

    if (result && result !== currentDirectory) {
      currentDirectory = result;
    }
    return currentDirectory;
  } catch (error) {
    return currentDirectory;
  }
});

// Test PowerShell availability
ipcMain.handle('test-powershell', async () => {
  return new Promise((resolve) => {
    const psCommand = process.platform === 'win32' ? 'powershell' : 'pwsh';
    const child = spawn(psCommand, ['-Command', 'Write-Host "PowerShell Test"'], { stdio: 'ignore' });
    
    child.on('close', (code) => {
      resolve(code === 0);
    });
    
    child.on('error', () => {
      resolve(false);
    });

    setTimeout(() => {
      child.kill();
      resolve(false);
    }, 3000);
  });
});

app.disableHardwareAcceleration();

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (powershellProcess) {
    powershellProcess.kill();
  }
});

// Keep the existing IPC handlers...
ipcMain.handle('get-system-info', () => {
  const totalMem = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  const freeMem = Math.round(os.freemem() / 1024 / 1024 / 1024);
  const usedMem = totalMem - freeMem;
  
  return {
    hostname: os.hostname(),
    username: os.userInfo().username,
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    uptime: Math.floor(os.uptime() / 60),
    totalmem: totalMem,
    usedmem: usedMem,
    freemem: freeMem,
    cpus: os.cpus()[0].model,
    cores: os.cpus().length,
    shell: 'PowerShell',
    terminal: 'electron-terminal'
  };
});

ipcMain.handle('read-logo', () => {
  try {
    return fs.readFileSync(path.join(__dirname, 'logo.txt'), 'utf8');
  } catch (error) {
    return `    ____                        ____  __         ____
   / __ \\____ _      _____  ____/ __ \\/ /_  ____ / / /
  / /_/ / __ \\ | /| / / _ \\/ ___/ /_/ / __ \\/ __ \`/ / / 
 / ____/ /_/ / |/ |/ /  __/ /  / ____/ / / / /_/ / / /  
/_/    \\____/|__/|__/\\___/_/  /_/   /_/ /_/\\____/_/_/   `;
  }
});

ipcMain.handle('read-config', () => {
  try {
    const config = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
    return JSON.parse(config);
  } catch (error) {
    return {
      theme: "dark",
      colors: {
        primary: "#00d787",
        secondary: "#5fafff",
        error: "#ff5f87"
      }
    };
  }
});

// Window controls
ipcMain.handle('window-minimize', () => {
  mainWindow.minimize();
});

ipcMain.handle('window-maximize', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.handle('window-close', () => {
  mainWindow.close();
});