// background.js - Handles requests from the UI, runs the model, then sends back a response

import { pipeline, env} from '@xenova/transformers';
import { openDB } from 'idb';

import { ChatWebLLM } from "@langchain/community/chat_models/webllm";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { Voy } from "voy-search";
// Skip initial check for local models, since we are not loading any local models.
env.allowLocalModels = false;

// Due to a bug in onnxruntime-web, we must disable multithreading for now.
// See https://github.com/microsoft/onnxruntime/issues/14445 for more information.
env.backends.onnx.wasm.numThreads = 1;
//env.backends.onnx.wasm.proxy = false;

const idb = {
    clippy_db: openDB("clippy_db", 1, {
        upgrade: (db) => {
            const store = db.createObjectStore('embeddings', { keyPath: 'url' });
            store.createIndex('page', 'page', { unique: false });

          }
      }),
  };

  async function add_embeddings(elements) {
    const db = await idb.clippy_db;
    const tx = db.transaction('embeddings', 'readwrite');
    const store = tx.objectStore('embeddings');
    elements.forEach(element => {
        store.put(element);
    });
    
    await tx.done;
  }

  async function get_embeddings(page) {
    const db = await idb.clippy_db;
    return await db.getAllFromIndex('embeddings', 'page', page );
  }

class EmbeddingPipelineSingleton {
    static task = 'feature-extraction';
    static model = 'Xenova/all-MiniLM-L6-v2';
    static instance = null;
    
    static async getInstance(progress_callback = null) {
        console.log("Singleton pipeline embeddings");
        if (this.instance === null) {
            this.instance = pipeline(this.task, this.model, { progress_callback });
        }

        return this.instance;
    }
}


class InstructModelSingleton {
    static async getInstance(progress_callback = null) {
        console.log("Instruct model");

        const webllmModel = new ChatWebLLM({
            model: "Phi-3-mini-4k-instruct-q4f16_1-MLC",
            chatOptions: {
                temperature: 0.1,
            },
            });

        await webllmModel.initialize(progress_callback);
        console.log("WEBLLM", webllmModel);
        return webllmModel
    }
}

const process = async(message) => {
    startHeartbeat();
    chrome.tabs.sendMessage(message.tab, {
        action: "clippy_start_processing",
    });
 
    const embeddings_page = await embed_text(message.text, message.url, message.tab, true);
    console.log("EP", embeddings_page)
    chrome.tabs.sendMessage(message.tab, {
        action: "clippy_speak",
        text: "Web page analisys done.",
        clear_text: true
    });
    chrome.tabs.sendMessage(message.tab, {
        action: "clippy_start_processing",
    });
    const resource = { embeddings: embeddings_page};
    const index = new Voy(resource);
    console.log("INDEX",index);
    const embeddings_query= await embed_text(message.query, message.url, message.tab, false);
    chrome.tabs.sendMessage(message.tab, {
        action: "clippy_start_processing",
    });
    const results = index.search(embeddings_query[0], 10);
    console.log("Similarity", results.neighbors);

    let context="";
    results.neighbors.forEach((result) =>
        context += `${result.title}\n`
    );

    console.log("Context", context)
    const answer = await answer_question(message.query, context, message.tab);
    
    chrome.tabs.sendMessage(message.tab, {
        action: "clippy_end_processing",
    });

    chrome.tabs.sendMessage(message.tab, {
        action: "clippy_speak",
        text: answer,
        clear_text: true,
        animation: "Explain"
    });
    stopHeartbeat();
    return answer;
   
};


const embed_text = async (text, page_url, tab_id, use_index_db) => {
    if (use_index_db) {
        const embeddings = await get_embeddings(page_url);
        console.log("IndexDb emb", embeddings)
        if (embeddings && embeddings.length > 0) {
            return embeddings;
        }
         
    }
    let extractor = await EmbeddingPipelineSingleton.getInstance((data) => {
        console.log('progress', data)
        if (data.status == 'initiate') {
            chrome.tabs.sendMessage(tab_id, {
                action: "clippy_speak",
                text: "Loading model file" + data.file  + " for embedding",
                clear_text: true
            });
        }
    });
    console.log("Text size", text.length)
    let result = (await extractor(text,  { pooling: 'mean', normalize: true })).tolist();
    console.log("EMBED result", result)
    const data = result.map(( emb , i) => ({
        id: String(i),
        title: text[i],
        url: `${page_url}/${i}`,
        page: `${page_url}`,
        embeddings: emb,
    }));
    if (use_index_db) {
        await add_embeddings(data);
    }
    return data;
};

const answer_question = async (question, context, tab_id) => {
    const WEBLLM_RESPONSE_SYSTEM_TEMPLATE = `You are Clippy, an helpfull assistant. Using the provided context, answer the user's question to the best of your ability using the resources provided.
Generate a SHORT and concise answer for a given question based solely on the context. You must only use information from the provided context. Use an unbiased and journalistic tone. Combine search results together into a coherent answer. Do not repeat text, stay focused, and stop generating when you have answered the question.
If there is nothing in the context relevant to the question at hand, just say "Hmm, I'm not sure." Don't try to make up an answer.`;

    console.log("answer_question METHOD\nQuestion:", question, "\nContext: ", context)
    let webllmModel = await InstructModelSingleton.getInstance((data) => {
        console.log(data)
        chrome.tabs.sendMessage(tab_id, {
            action: "clippy_speak",
            text: data.text,
            clear_text: true
        });
    });
    chrome.tabs.sendMessage(tab_id, {
        action: "clippy_start_processing",
    });
    // Best guess at Phi-3 tokens
    let chatModel = webllmModel.bind({
        stop: ["\nInstruct:", "Instruct:", "<hr>", "\n<hr>", "<|", "\n\n"],
    });
    const messages = [
        new SystemMessage({ content: WEBLLM_RESPONSE_SYSTEM_TEMPLATE}),
        new HumanMessage({ content: `When responding to me, use the following documents as context:\n<context>\n${context}\n</context>`}),
        new AIMessage({content: "Understood! I will use the documents between the above <context> tags as context when answering your next questions."}),
        new HumanMessage({content: `${question}` })
      
    ];
    console.log("Messages", messages)
    const response = await webllmModel.invoke(messages);
    console.log("Response", response)
    
    const answer = response.content.trim();
    return answer;

};



chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action == 'process') {
        // Run model prediction asynchronously
        (async function () {
            try {
            let result = await process(message);
            sendResponse(result);
            }
            catch(error) {
                console.error("Si è verificato un errore: ", error.message);
                chrome.tabs.sendMessage(message.tab, {
                    action: "clippy_speak",
                    text: error.message,
                    clear_text: true
                });
                sendResponse("Error: " + error.message);
            }

        })();
        return true;
    }
});

let heartbeatInterval;

async function runHeartbeat() {
  await chrome.storage.local.set({ 'last-heartbeat': new Date().getTime() });
}

async function startHeartbeat() {
  runHeartbeat().then(() => {
    heartbeatInterval = setInterval(runHeartbeat, 20 * 1000);
  });
}

async function stopHeartbeat() {
  clearInterval(heartbeatInterval);
}