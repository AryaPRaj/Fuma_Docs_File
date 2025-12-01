import Groq from 'groq-sdk';
import { Pinecone } from '@pinecone-database/pinecone';
import { pipeline } from '@xenova/transformers';

// Initialize Groq client
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

// Initialize Pinecone client
const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY!,
});

export async function POST(req: Request) {
    const { messages } = await req.json();
    const lastMessage = messages[messages.length - 1];

    // 1. Embed the user's message
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    const output = await extractor(lastMessage.content, { pooling: 'mean', normalize: true });
    const embedding = Array.from(output.data);

    // 2. Query Pinecone
    const index = pinecone.index('my-app-index');
    const queryResponse = await index.query({
        vector: embedding,
        topK: 3,
        includeMetadata: true,
    });

    // 3. Construct context
    const context = queryResponse.matches
        .map((match) => match.metadata?.text)
        .join('\n\n---\n\n');

    // Extract unique sources for references
    const sources = Array.from(new Set(
        queryResponse.matches
            .map((match) => match.metadata?.source as string)
            .filter(Boolean)
    ));

    // 4. Create system prompt with context
    const systemPrompt = `You are a helpful AI assistant for this documentation site.

CRITICAL RULES:
1. You must ONLY answer using information from the Context section below
2. DO NOT mention any external websites, URLs, or documentation (like fumadocs.dev or any other sites)
3. DO NOT use any knowledge from your training - ONLY use what's in the Context
4. If the Context doesn't have enough information, say "I don't have that information in the documentation"
5. Keep answers concise and based strictly on the Context provided

Context:
${context}`;

    // 5. Stream response from Groq
    const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
            { role: 'system', content: systemPrompt },
            ...messages,
        ],
        stream: true,
    });

    // 6. Create a readable stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            try {
                for await (const chunk of completion) {
                    const content = chunk.choices[0]?.delta?.content || '';
                    if (content) {
                        controller.enqueue(encoder.encode(content));
                    }
                }

                // Append references after the AI response
                if (sources.length > 0) {
                    const referencesText = '\n\n---\n**References:**\n' + sources.map(source => {
                        // Normalize Windows backslashes to forward slashes
                        const normalizedPath = source.replace(/\\/g, '/');

                        // Convert file path to URL
                        // e.g., content/docs/Deploying.mdx -> /docs/Deploying
                        const urlPath = normalizedPath
                            .replace('content/', '/')
                            .replace(/\.mdx?$/, '')
                            .replace(/\/index$/, '');

                        // Extract title from path
                        const title = normalizedPath.split('/').pop()?.replace(/\.mdx?$/, '') || 'Documentation';

                        return `- [${title}](${urlPath})`;
                    }).join('\n');

                    controller.enqueue(encoder.encode(referencesText));
                }

                controller.close();
            } catch (error) {
                controller.error(error);
            }
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Transfer-Encoding': 'chunked',
        },
    });
}
