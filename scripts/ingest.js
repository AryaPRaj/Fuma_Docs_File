
const { Pinecone } = require('@pinecone-database/pinecone');
const fs = require('fs').promises;
const path = require('path');
const envPath = path.resolve(process.cwd(), '.env');
console.log('Loading .env from:', envPath);
require('dotenv').config({ path: envPath });

const PINECONE_INDEX_NAME = 'my-app-index';

// Simple text splitter
function splitText(text, chunkSize = 1000, chunkOverlap = 200) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
        chunks.push(text.slice(start, end));
        start += chunkSize - chunkOverlap;
    }
    return chunks;
}

async function main() {
    console.log('Starting ingestion...');

    if (!process.env.PINECONE_API_KEY) {
        console.error('PINECONE_API_KEY is missing');
        process.exit(1);
    }

    const pinecone = new Pinecone({
        apiKey: process.env.PINECONE_API_KEY,
    });

    // Check if index exists, if not create it
    const indexList = await pinecone.listIndexes();
    const indexExists = indexList.indexes?.some(i => i.name === PINECONE_INDEX_NAME);

    if (!indexExists) {
        console.log(`Creating index ${PINECONE_INDEX_NAME}...`);
        await pinecone.createIndex({
            name: PINECONE_INDEX_NAME,
            dimension: 384, // Xenova/all-MiniLM-L6-v2 dimension
            metric: 'cosine',
            spec: {
                serverless: {
                    cloud: 'aws',
                    region: 'us-east-1',
                },
            },
        });
        // Wait for index to be ready
        console.log('Waiting for index to initialize...');
        await new Promise(resolve => setTimeout(resolve, 60000));
    }

    const index = pinecone.index(PINECONE_INDEX_NAME);

    // Read docs
    const docsDir = path.join(process.cwd(), 'content/docs');

    async function getFiles(dir) {
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(dirents.map((dirent) => {
            const res = path.resolve(dir, dirent.name);
            return dirent.isDirectory() ? getFiles(res) : res;
        }));
        return Array.prototype.concat(...files).filter(f => f.endsWith('.md') || f.endsWith('.mdx'));
    }

    const files = await getFiles(docsDir);
    console.log(`Found ${files.length} files.`);

    const chunks = [];

    for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        const fileChunks = splitText(content);
        fileChunks.forEach((text, idx) => {
            chunks.push({
                id: `${path.relative(process.cwd(), file)}-${idx}`.replace(/[^a-zA-Z0-9-_]/g, '_'),
                text,
                source: path.relative(process.cwd(), file)
            });
        });
    }

    console.log(`Split into ${chunks.length} chunks.`);

    // Embed and Upsert
    const BATCH_SIZE = 10;

    // Use dynamic import for transformers
    const { pipeline } = await import('@xenova/transformers');
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const batchTexts = batch.map(c => c.text);

        // Generate embeddings
        const embeddings = [];
        for (const text of batchTexts) {
            const output = await extractor(text, { pooling: 'mean', normalize: true });
            embeddings.push(Array.from(output.data));
        }

        const vectors = batch.map((chunk, idx) => ({
            id: chunk.id,
            values: embeddings[idx],
            metadata: {
                text: chunk.text,
                source: chunk.source,
            },
        }));

        await index.upsert(vectors);
        console.log(`Upserted batch ${i / BATCH_SIZE + 1}/${Math.ceil(chunks.length / BATCH_SIZE)}`);
    }

    console.log('Ingestion complete!');
}

main().catch(console.error);
