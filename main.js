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

// Handle directory change commands specially
ipcMain.handle('change-directory', async (event, targetDir) => {
  let newDir;
  
  try {
    // Handle special cases
    if (targetDir === '~' || targetDir === '') {
      newDir = os.homedir();
    } else if (targetDir === '..') {
      newDir = path.dirname(currentDirectory);
    } else if (targetDir === '.') {
      newDir = currentDirectory;
    } else if (path.isAbsolute(targetDir)) {
      newDir = targetDir;
    } else {
      newDir = path.resolve(currentDirectory, targetDir);
    }

    // Normalize the path
    newDir = path.normalize(newDir);

    // Check if directory exists
    if (fs.existsSync(newDir)) {
      const stats = fs.statSync(newDir);
      if (stats.isDirectory()) {
        currentDirectory = newDir;
        return { success: true, newPath: currentDirectory, error: '' };
      } else {
        return { success: false, newPath: currentDirectory, error: `'${targetDir}' is not a directory` };
      }
    } else {
      return { success: false, newPath: currentDirectory, error: `Directory '${targetDir}' does not exist` };
    }
  } catch (error) {
    return { success: false, newPath: currentDirectory, error: error.message };
  }
});

// Get current directory
ipcMain.handle('get-current-directory', async () => {
  return currentDirectory;
});

// Execute single PowerShell commands with proper working directory
ipcMain.handle('execute-powershell-single', async (event, command) => {
  return new Promise((resolve) => {
    const psCommand = process.platform === 'win32' ? 
      (fs.existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe') ? 'pwsh' : 'powershell') : 
      'pwsh';
    
    const args = ['-NoLogo', '-NoProfile', '-Command', command];

    console.log(`Executing: ${psCommand} in directory: ${currentDirectory}`);
    
    const child = spawn(psCommand, args, {
      cwd: currentDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
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
      // Clean up output
      output = output.replace(/\r\n/g, '\n').trim();
      errorOutput = errorOutput.replace(/\r\n/g, '\n').trim();
      
      if (code !== 0 && errorOutput) {
        resolve({ output: output, error: errorOutput, success: false });
      } else {
        resolve({ output: output, error: '', success: true });
      }
    });

    child.on('error', (err) => {
      resolve({ output: '', error: err.message, success: false });
    });

    // Timeout protection
    setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ output: '', error: 'Command timeout', success: false });
    }, 15000); // 15 second timeout
  });
});

// Test PowerShell availability
ipcMain.handle('test-powershell', async () => {
  return new Promise((resolve) => {
    const psCommand = process.platform === 'win32' ? 
      (fs.existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe') ? 'pwsh' : 'powershell') : 
      'pwsh';
    
    const child = spawn(psCommand, ['-Command', 'Write-Host "PowerShell Test"'], { 
      stdio: 'ignore',
      timeout: 3000
    });
    
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

// Enhanced directory listing with better formatting
ipcMain.handle('list-directory', async (event, dirPath = null) => {
  const targetDir = dirPath || currentDirectory;
  
  return new Promise((resolve) => {
    const psCommand = process.platform === 'win32' ? 
      (fs.existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe') ? 'pwsh' : 'powershell') : 
      'pwsh';
    
    // PowerShell command to list directory with Unix-like format
    const command = `Get-ChildItem -Path "${targetDir}" | ForEach-Object { 
      $size = if ($_.PSIsContainer) { "DIR" } else { $_.Length }
      $date = $_.LastWriteTime.ToString("MMM dd HH:mm")
      $name = $_.Name
      if ($_.PSIsContainer) { $name = $name + "/" }
      "{0,-10} {1,-20} {2}" -f $size, $date, $name
    }`;

    const child = spawn(psCommand, ['-NoLogo', '-NoProfile', '-Command', command], {
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
      if (errorOutput) {
        resolve({ output: '', error: errorOutput.trim(), success: false });
      } else {
        resolve({ output: output.trim(), error: '', success: true });
      }
    });

    child.on('error', (err) => {
      resolve({ output: '', error: err.message, success: false });
    });

    setTimeout(() => {
      child.kill();
      resolve({ output: '', error: 'Command timeout', success: false });
    }, 5000);
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

// System info handler
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