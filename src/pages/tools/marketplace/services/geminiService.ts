import { GoogleGenAI } from "@google/genai";

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!_ai) {
    const key = import.meta.env.VITE_GEMINI_API_KEY;
    if (!key) throw new Error("VITE_GEMINI_API_KEY is not set. Add it to your environment variables.");
    _ai = new GoogleGenAI({ apiKey: key });
  }
  return _ai;
}

export interface MarketplaceContent {
  en: {
    title: string;
    description: string;
    bulletPoints: string[];
  };
  ar: {
    title: string;
    description: string;
    bulletPoints: string[];
  };
}

export const generateMarketplaceContent = async (productDetails: Record<string, any>): Promise<MarketplaceContent> => {
  const prompt = `
    You are an expert e-commerce copywriter for Amazon and Noon UAE/KSA.
    Generate optimized marketplace content for the following product details:
    ${JSON.stringify(productDetails, null, 2)}

    STRICT TITLE REQUIREMENTS:
    1. Structure: [Brand Name] - [Model Number] - [Product Name] [Key Attributes/Style] [Color/Size].
       Example: "Reebok Work - IB3484 - Nano X1 Adventure Safety Men's Composite Toe Work Shoes Lightweight, Slip-Resistant, Metal-Free Trail Sneakers, Size 37 Wide"
    2. Consistency: If you are generating for multiple variants of the same product, the Title, Description, and Bullet Points MUST be identical for all rows, with the ONLY difference being the 'Size' or 'Color' attribute at the end of the Title.
    3. Character limit: 80-150 characters (Max 200). DO NOT exceed 200.
    4. Special Characters: NO "!", "$", "?", "_", "{", "}", "^", "¬", "¦". Use standard hyphens and commas only.
    5. Promotional Content: NO "free shipping", "guaranteed", "best seller", or "hot item".
    6. Numbers: Use numerals (2 instead of Two).
    7. Capitalization: Capitalize the first letter of each word (except prepositions like 'in', 'on', 'with', conjunctions like 'and', 'or', and articles like 'the', 'a', 'an').
    8. NO ALL CAPS.
    9. Abbreviations: Use "cm", "oz", "in", "kg".

    DESCRIPTION & BULLETS:
    - Description: Concise, engaging, focuses on performance.
    - Bullets: Exactly 5 highly informative bullet points.

    OUTPUT:
    - Provide content in both English (EN) and Arabic (AR).
    - Ensure Arabic is professional and optimized for GCC markets.

    Return the result in the following JSON format ONLY:
    {
      "en": { "title": "...", "description": "...", "bulletPoints": ["...", "...", "...", "...", "..."] },
      "ar": { "title": "...", "description": "...", "bulletPoints": ["...", "...", "...", "...", "..."] }
    }
  `;

  const response = await getAI().models.generateContent({
    model: "gemini-2.0-flash",
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
    },
  });

  try {
    return JSON.parse(response.text || "{}") as MarketplaceContent;
  } catch (error) {
    console.error("Failed to parse Gemini response:", error);
    throw new Error("Failed to generate content in the correct format.");
  }
};
