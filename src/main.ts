import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
const { updateElectronApp } = require('update-electron-app');
import log from 'electron-log/main';

import path from 'path';
import fs from 'fs';
import { Document, VectorStoreIndex } from 'llamaindex';
import { sendMessageToGemini } from './lib/gemini';
import { promptGenerateCards } from './lib/prompts';
import { GetTextFromPDF, getMetadata } from './lib/utils';
import { 
  Card,
  createEmptyCard,
  generatorParameters,
  FSRSParameters,
  FSRS,
  fsrs,
  RecordLog,
  Rating
} from 'ts-fsrs';
import { getWikiTitle, getWikiData, getPathInfo } from './lib/utils';
import { Thought, ThoughtStream } from './lib/thoughtstream';

log.initialize();

updateElectronApp(); // additional configuration options available

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const createWindow = () => {  
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    // frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // this opens all <a> links with target "_blank" in the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  })

  // and load the HTMLs of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    // mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/convo.html`));

  }

  // Open the DevTools.
  // mainWindow.webContents.openDevTools();

  return mainWindow;
};


// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  const win = createWindow();
  win.once('ready-to-show', () => {
    win.webContents.setZoomFactor(0.8);
    win.show();
  })

  let thoughtstream = new ThoughtStream();

  const userDataPath = path.join(app.getPath('userData'), 'user_data.json');
  log.info(userDataPath);

  const saveUserData = (key: string, value: string) => {
    let data;
    if (fs.existsSync(userDataPath)) {
      data = JSON.parse(fs.readFileSync(userDataPath, 'utf-8'));
      log.info('data', data)
    } else {
      data = {};
    }
    data[key] = value;
    log.info('new data', data)
    fs.writeFileSync(userDataPath, JSON.stringify(data));
  };

  const getLearningPath = (): string => {
    if (fs.existsSync(userDataPath)) {
      const { learningPath } = JSON.parse(fs.readFileSync(userDataPath, 'utf-8'));
      return learningPath;
    }
    throw Error('Learning path is not in app userData');
  }

  ipcMain.handle('reload', async (event) => {
    await win.reload();
    return 'success';
  })

  ipcMain.handle('dialog:openFiles', async (event) => {
    try {
      let path;
      const { canceled, filePaths } = await dialog
        .showOpenDialog({
          properties: ["openFile", "multiSelections"]
        });
      if (!canceled) {
        return filePaths;
      }
    } catch(e) {
      log.error(e);
      return null;
    }
  })

  ipcMain.handle('dialog:openFolder', async (event) => {
    try {
      let path;
      const { canceled, filePaths } = await dialog
        .showOpenDialog({
            properties: ["openDirectory", "createDirectory"],
        });
      if (!canceled) {
        saveUserData('learningPath', path);
        return filePaths[0];
      }
    } catch(e) {
      log.error(e);
      return null;
    }
  });

  ipcMain.on('saveName', (event, name: string) => {
    saveUserData('name', name);
  });

  ipcMain.on("saveLearningPath", (event, path: string) => {
    saveUserData('learningPath', path);
  });

  ipcMain.handle('saveSources', async (event, sources: string[]) => {
    try {
      const targetFolder = getLearningPath() + '/sources';
      if (!fs.existsSync(targetFolder)) {
        fs.mkdirSync(targetFolder);
      }
      let promises: Promise<void>[] = [];
      sources.forEach((source) => {
        if (!(getWikiTitle(source))) {
          const { filename, extension } = getPathInfo(source);
          const target = targetFolder + '/' + filename + '.' + extension;
          promises.push(fs.promises.copyFile(
            source, 
            target,
            fs.constants.COPYFILE_FICLONE, // overwrites source file if it exists
          ));
        } 
      })
      await Promise.all(promises);
      return 'success';
    } catch(e) {
      log.error(e);
      return `error: ${e}`;
    }
  });

  ipcMain.handle('getUserInfo', (event) => {
    let data = {};
    if (fs.existsSync(userDataPath)) {
      data = JSON.parse(fs.readFileSync(userDataPath, 'utf-8'));
      log.info('data', data)
    } 
    return data;
  })

  const getFileText = async (path: string) => {
    let material: string;
    if (path.endsWith('.pdf')) {
      // Process PDF file
      material = await GetTextFromPDF(path);
    } else if (path.endsWith('.txt') || path.endsWith('.md')) {
      // Read text file or markdown file
      material = await fs.promises.readFile(path, 'utf-8');
    } else {
      throw new Error('Unsupported file type');
    }
    return material;
  }

  ipcMain.handle('generateMaterials', async (event, sources: string[], notes: string, nCards: number) => {
    // TODO: Athena - break down into separate functions 
    try {
      let promises: Promise<string>[] = [];
      sources.forEach((source) => {
        const wikiTitle = getWikiTitle(source);
        if (wikiTitle) { // wiki url
          promises.push(getWikiData(source));
        } 
        if (getPathInfo(source)) { // local file
          promises.push(getFileText(source));
        }
      });

      let targetFilename = '';
      if (sources.length === 1) {
        const wikiTitle = getWikiTitle(sources[0]);
        if (wikiTitle) {
          targetFilename = wikiTitle + '.md';
        } else {
          targetFilename = getPathInfo(sources[0]).filename + '.md';
        }
      } 

      const materials: PromiseSettledResult<string>[] = await Promise.allSettled(promises);
      const materialStrings = materials.map(result => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          log.error(`Error processing material: ${result.reason}`);
          return '';
        }
      });

      const prompt = promptGenerateCards(targetFilename, materialStrings, notes, nCards);
      log.info('PROMPT: ', prompt);

      const qaPairs = await sendMessageToGemini(prompt);
      log.info('QAPAIRS: ', prompt);

      const flashcardPath = getLearningPath() + '/flashcards'
      if (!fs.existsSync(flashcardPath)) {
        fs.mkdirSync(flashcardPath);
      }

      if (sources.length > 1) {
        targetFilename = await sendMessageToGemini(`Return a markdown filename ONLY based on context below.
        Your example response 1: "Luis von Ahn.md"
        Your example response 2: "Augmenting Long Term Memory.md"
        Your example response 3: "How to Make Dalgona Coffee.md"
        ---
        Context: 
        ${qaPairs}
        ---
        `);
        log.info('hmmmm', targetFilename);
        targetFilename = targetFilename.trim().replace(/^[*_'\-"`?]+|[*_'\-"`?]+$/g, '');
      }
      const metadata = getMetadata(sources);

      // file written here 
      await fs.promises.writeFile(flashcardPath + '/' + targetFilename, metadata + qaPairs)
      return { filename: targetFilename, metadata, qaPairs };
       
    } catch(e) {
      log.error(e);
      return {};
    }

  });

  const parseMarkdownToQAPairs = (markdown: string) => {
    const qaPairs: { question: string, answer: string }[] = [];
    
    // Remove sources 
    log.info('markdown', markdown);
    markdown = markdown.replace(/---[\s\S]*?---/g, '');
    log.info('markdown', markdown);


    // Regex to match question and answer pairs
    const qaRegex = /([\s\S]+?)\n\?\n([\s\S]+?)(?=\n\n|$)/g;
    let match;
  
    while ((match = qaRegex.exec(markdown)) !== null) {
      const question = match[1].trim();
      const answer = match[2].trim();
      qaPairs.push({ question, answer });
    }
  
    return qaPairs;
  }

  ipcMain.handle('getQAPairsFromMarkdown', async (event, targetFilename: string) => {
    try {
      const filePath = path.join(getLearningPath(), 'flashcards', targetFilename);
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const qaPairs = parseMarkdownToQAPairs(content);
      return qaPairs;
    } catch (error) {
      log.error(error);
      return null;
    }
  });

  ipcMain.handle('saveModifiedCards', async (event, targetFilename: string, qaPairs: { question: string, answer: string }[]) => {
    try {
      const filePath = path.join(getLearningPath(), 'flashcards', targetFilename);
      let markdown = '';
  
      // Construct the new markdown content from the QA pairs
      qaPairs.forEach(({ question, answer }) => {
        markdown += `${question}\n?\n${answer}\n\n`;
      });
  
      if (fs.existsSync(filePath)) {
        // Read the existing file content
        let fileContent = await fs.promises.readFile(filePath, 'utf-8');
  
        const sources = fileContent.match(/---[\s\S]*?---/g);
        log.info('sections', sources)
        
        if (sources && sources.length > 1) {
          let combinedSources = '';
          combinedSources = sources.join('\n'); // Join all matched . into a single string
          fileContent = combinedSources + '\n\n' + markdown;
        } else {
          fileContent = markdown;
        }

        log.info('fileContent', fileContent)
  
        await fs.promises.writeFile(filePath, fileContent);
      } else {
        // If the file does not exist, create it with the new markdown content
        await fs.promises.writeFile(filePath, markdown);
      }
      return true;
    } catch (error) {
      log.error(error);
      return false;
    }
  });

  ipcMain.handle('sync', (cards) => {

    // let card: Card = createEmptyCard();
    // const f: FSRS = new FSRS(); 
    // let scheduling_cards: RecordLog = f.repeat(card, new Date());

    // const good: RecordLogItem = scheduling_cards[Rating.Good];
    // const newCard: Card = good.card;

    // log.info(card)
    // log.info(f)
    // log.info(scheduling_cards)
    // log.info(good)
    // log.info(newCard)

    return [
      {
        front: 'This is the front of card 1',
        back: 'This is the back of card 1',
        interval: 1,
        ease: 250
      },
      {  
        front: 'This is the front of card 2',
        back: 'This is the back of card 2',
        interval: 1,
        ease: 250
      }
    ];
  });

  ipcMain.handle('addThought', (event, t: Thought) => {
    thoughtstream.addThought(t);
  })


});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
