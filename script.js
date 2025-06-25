let csvFileInput, statusDisplay, chatbox, userMessageInput, sendButton,
    apiKeyStatus, apiKeyLoadingBar, fileLoadingBar;

let csvData = [];
let headers = [];
let fullCsvText = '';
let isModelReady = false;
let isDataLoaded = false;
const MAX_CONTEXT_CHARS = 7000;   // הורדתי מה-15000 המקורי כדי למנוע קיצוצים חריפים בפרומפט
const MAX_ROWS_IN_CONTEXT = 80;

const LOCAL_LLM_ENDPOINT = "http://localhost:8080/v1/chat/completions";

document.addEventListener('DOMContentLoaded', () => {
    csvFileInput = document.getElementById('csvFile');
    statusDisplay = document.getElementById('status');
    chatbox = document.getElementById('chatbox');
    userMessageInput = document.getElementById('userMessage');
    sendButton = document.getElementById('sendButton');
    apiKeyStatus = document.getElementById('apiKeyStatus');
    apiKeyLoadingBar = document.getElementById('apiKeyLoadingBar');
    fileLoadingBar = document.getElementById('fileLoadingBar');

    if (csvFileInput) csvFileInput.addEventListener('change', handleFileUpload);
    if (sendButton && userMessageInput) {
        sendButton.addEventListener('click', handleSendMessage);
        userMessageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !sendButton.disabled) handleSendMessage();
        });
    }

    updateStatusText(apiKeyStatus, "המודל המקומי זמין ומוכן.", "success");
    isModelReady = true;
    hideLoadingBar(apiKeyLoadingBar);
    checkEnableSend();
});

function updateStatusText(element, message, type = 'info') {
    if (element) {
        element.textContent = message;
        element.className = `status-${type}`;
    }
}
function showLoadingBar(barElement) { if (barElement) barElement.style.display = 'block'; }
function hideLoadingBar(barElement) { if (barElement) barElement.style.display = 'none'; }

function checkEnableSend() {
    const enabled = isModelReady && isDataLoaded;
    if (userMessageInput) userMessageInput.disabled = !enabled;
    if (sendButton) sendButton.disabled = !enabled;
    if (userMessageInput) {
        if (enabled) userMessageInput.placeholder = "שאל אותי על נתוני ה-CSV...";
        else if (!isModelReady) userMessageInput.placeholder = "המודל לא מוכן...";
        else userMessageInput.placeholder = "אנא טען קובץ CSV...";
    }
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    isDataLoaded = false;
    checkEnableSend();
    if (!file) {
        updateStatusText(statusDisplay, "לא נבחר קובץ.", "error");
        return;
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
        updateStatusText(statusDisplay, "אנא טען קובץ CSV בלבד.", "error");
        csvFileInput.value = '';
        return;
    }

    updateStatusText(statusDisplay, `טוען את הקובץ: ${file.name}...`, "loading");
    showLoadingBar(fileLoadingBar);
    csvData = []; headers = []; fullCsvText = '';
    if (chatbox) chatbox.innerHTML = '';

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const text = e.target.result;
            fullCsvText = text;
            parseCSV(text);
            if (csvData.length > 0) {
                updateStatusText(statusDisplay, `נטענו ${csvData.length} שורות. מוכן לשאלות!`, "success");
                isDataLoaded = true;
                addMessage({ textResponse: `נטענו ${csvData.length} שורות עם הכותרות: ${headers.join(', ')}.` });
            } else {
                updateStatusText(statusDisplay, "לא נמצאו שורות נתונים.", "warning");
                addMessage({ textResponse: "לא נמצאו שורות נתונים בקובץ." });
            }
        } catch (error) {
            updateStatusText(statusDisplay, `שגיאה: ${error.message}`, "error");
        } finally {
            hideLoadingBar(fileLoadingBar);
            checkEnableSend();
        }
    };
    reader.readAsText(file, 'UTF-8');
}

function parseCSV(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
    if (lines.length === 0) return;
    const DELIMITER = detectDelimiter(lines[0]);
    headers = lines[0].split(DELIMITER).map(h => h.trim());
    csvData = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const values = line.split(DELIMITER).map(v => v.trim());
        if (values.length !== headers.length) continue;
        const row = {};
        headers.forEach((h, j) => row[h] = values[j]);
        csvData.push(row);
    }
}

function detectDelimiter(headerLine) {
    const candidates = [',', ';', '\t', '|'];
    let best = ',', max = 0;
    for (const d of candidates) {
        const count = headerLine.split(d).length;
        if (count > max) {
            max = count;
            best = d;
        }
    }
    return best;
}

function getCSVContextForPrompt() {
    let context = `כותרות: ${headers.join(', ')}\nסה"כ שורות: ${csvData.length}\n\n`;
    const sampleSize = Math.min(csvData.length, MAX_ROWS_IN_CONTEXT);
    for (let i = 0; i < sampleSize; i++) {
        const row = headers.map(h => `"${h}":"${csvData[i][h] || ''}"`).join(', ');
        const line = `{${row}}\n`;
        if (context.length + line.length < MAX_CONTEXT_CHARS) context += line;
        else break;
    }
    return context;
}

async function handleSendMessage() {
    const messageText = userMessageInput.value.trim();
    if (!messageText || !isModelReady || !isDataLoaded) return;
    addMessage({ textResponse: messageText }, 'user');
    userMessageInput.value = '';
    userMessageInput.disabled = true;
    sendButton.disabled = true;

    const thinking = addMessage({ textResponse: "מעבד בקשה..." }, 'bot');
    if (thinking) thinking.classList.add('thinking');

    try {
        const botResponse = await getLlamaResponse(messageText);
        if (chatbox && thinking && chatbox.contains(thinking)) chatbox.removeChild(thinking);
        addMessage(botResponse, 'bot');
    } catch (error) {
        console.error(error);
        if (chatbox && thinking && chatbox.contains(thinking)) chatbox.removeChild(thinking);
        addMessage({ textResponse: `שגיאה בתקשורת עם המודל: ${error.message}` }, 'bot');
    } finally {
        checkEnableSend();
    }
}

async function getLlamaResponse(query) {
    const csvContext = getCSVContextForPrompt();

    const messages = [
        {
            role: "system",
            content: `אתה עוזר AI בשם ג'ארוויס, המנתח נתוני CSV.
ענה בעברית, אל תמציא מידע שאינו מופיע.
החזר JSON עם textResponse ו-chartConfig.`
        },
        {
            role: "user",
            content: `הקשר נתוני CSV:\n${csvContext}\n\nשאלה:\n"${query}"`
        }
    ];

    const payload = {
        model: "tinyllama-1.1b-chat-v1.0",
        messages: messages,
        max_tokens: 200,         // כמות פלט מקסימלית
        stop: ["\n\n", "###"]   // עצירה על סימנים אופציונליים
    };

    const response = await fetch(LOCAL_LLM_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`שגיאת שרת: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) throw new Error("לא התקבל תוכן מהמודל.");

    try {
        return JSON.parse(content);
    } catch (e) {
        // אם לא JSON תקין, מחזירים טקסט גולמי
        console.warn("המודל החזיר טקסט לא JSON, מחזיר טקסט גולמי:", content);
        return { textResponse: content };
    }
}

function addMessage(response, sender = 'bot') {
    if (!chatbox) return null;
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message', `${sender}-message`);

    if (response.textResponse) {
        const text = document.createElement('div');
        text.textContent = response.textResponse;
        messageDiv.appendChild(text);
    }

    if (sender === 'bot' && response.chartConfig) {
        const chartId = `chart-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const chartWrapper = document.createElement('div');
        chartWrapper.classList.add('chart-wrapper');
        const canvas = document.createElement('canvas');
        canvas.id = chartId;
        chartWrapper.appendChild(canvas);
        messageDiv.appendChild(chartWrapper);

        setTimeout(() => {
            try {
                response.chartConfig.options = response.chartConfig.options || {};
                response.chartConfig.options.maintainAspectRatio = false;
                new Chart(document.getElementById(chartId), response.chartConfig);
            } catch (e) {
                console.error("Chart error:", e);
                chartWrapper.innerHTML = `<p style="color:red;">שגיאה בתרשים: ${e.message}</p>`;
            }
        }, 100);
    }

    chatbox.appendChild(messageDiv);
    chatbox.scrollTop = chatbox.scrollHeight;
    return messageDiv;
}




/*

./build/bin/llama-server \
  -m ./models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8080

*/