const getApiKey = (): string => {
  const key = import.meta.env.VITE_GEMINI_API_KEY;
  if (!key) throw new Error("VITE_GEMINI_API_KEY is not set.");
  return key;
};

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
    1. Structure (in this exact order): [Brand] + [Model] + [Department/Target Audience] + [Product Type] + [Key Feature 1] + [Key Feature 2] + [Key Feature 3] + [Color] + [Size]
       Example: "Reebok - IB3484 - Men's - Safety Work Shoe - Composite Toe - Lightweight - Slip-Resistant - Black - Size 42"
    2. Variant Consistency: If multiple rows share the same Brand + Model, their Title, Description, and Bullet Points MUST be 100% identical — ONLY the Color and/or Size at the end of the title should differ.
    3. Character limit: 80-200 characters. DO NOT exceed 200.
    4. Special Characters: NO "!", "$", "?", "_", "{", "}", "^", "¬", "¦". Use standard hyphens to separate segments.
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

  const apiKey = getApiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  try {
    const parsed = JSON.parse(raw) as MarketplaceContent;
    if (!parsed?.en?.title || !parsed?.ar?.title) throw new Error("Missing required fields");
    return parsed;
  } catch (error) {
    console.error("Failed to parse Gemini response:", raw);
    throw new Error("Gemini parse error: " + raw.slice(0, 300));
  }
};
