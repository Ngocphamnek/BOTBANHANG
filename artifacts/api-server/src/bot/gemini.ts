import { GoogleGenAI } from "@google/genai";
import { logger } from "../lib/logger.js";

const apiKey = process.env.GEMINI_API_KEY;

let genai: GoogleGenAI | null = null;

if (apiKey) {
  genai = new GoogleGenAI({ apiKey });
} else {
  logger.warn("GEMINI_API_KEY not set — AI auto-reply disabled");
}

const SYSTEM_PROMPT = `Bạn là trợ lý bán hàng của GC MMO Shop, một cửa hàng chuyên bán tài khoản số và dịch vụ MMO tại Việt Nam (Netflix, Spotify, ChatGPT, VPN, v.v.).
Hãy trả lời ngắn gọn, thân thiện bằng tiếng Việt.
Nếu khách hỏi về sản phẩm, hướng dẫn họ dùng lệnh /start để xem danh sách.
Nếu khách hỏi về đơn hàng, hướng dẫn dùng /orders.
Không bịa đặt thông tin về sản phẩm hoặc giá cả.
Trả lời tối đa 3-4 câu.`;

export async function getGeminiReply(userMessage: string): Promise<string | null> {
  if (!genai) return null;

  try {
    const response = await genai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        maxOutputTokens: 256,
      },
    });
    return response.text ?? null;
  } catch (err) {
    logger.error({ err }, "Gemini API error");
    return null;
  }
}
