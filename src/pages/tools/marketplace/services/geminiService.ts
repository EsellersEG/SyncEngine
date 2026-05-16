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

function trimProductDetails(product: Record<string, any>): Record<string, any> {
  const trimmed: Record<string, any> = {};
  for (const [key, value] of Object.entries(product)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      trimmed[key] = value;
    }
  }
  return trimmed;
}

/** Get the brand exactly as written in the sheet */
function getBrand(product: Record<string, any>): string {
  return (product.Brand || product.brand || product.BRAND || '').trim();
}

/** Get the model exactly as written in the sheet */
function getModel(product: Record<string, any>): string {
  return (product['Model Number'] || product.model || product.Model || product['Model'] || product.SKU?.split('-')?.[0] || '').trim();
}

/** Get color from the product */
function getColor(product: Record<string, any>): string {
  return (product.Color || product.color || product.COLOR || product.Colour || '').trim();
}

/** Get size from the product */
function getSize(product: Record<string, any>): string {
  return (product.Size || product.size || product.SIZE || '').trim();
}

/** Get the handle — products sharing the same handle are variants */
function getHandle(product: Record<string, any>): string {
  return (product.Handle || product.handle || product.HANDLE || '').trim();
}

/** Build a cache key for grouping variants — by Handle */
export function getGroupKey(product: Record<string, any>): string {
  const handle = getHandle(product);
  if (handle) return handle.toLowerCase();
  // Fallback if no Handle column: use brand+model
  return `${getBrand(product)}|||${getModel(product)}`.toLowerCase();
}

/** Build a prompt for a product group (one AI call per brand+model group) */
function buildGroupPrompt(representative: Record<string, any>, variantSummary: string, headers: string[]): string {
  const trimmed = trimProductDetails(representative);
  const brand = getBrand(representative);
  const model = getModel(representative);

  // Remove variant-specific fields so AI doesn't reference them
  const genericProduct = { ...trimmed };
  delete genericProduct.Color; delete genericProduct.color; delete genericProduct.COLOR; delete genericProduct.Colour;
  delete genericProduct.Size; delete genericProduct.size; delete genericProduct.SIZE;
  delete genericProduct.SKU; delete genericProduct.sku;
  delete genericProduct['International Barcode']; delete genericProduct.barcode;

  return `You are an expert e-commerce copywriter for Amazon and Noon UAE/KSA.

PRODUCT DATA (from spreadsheet with columns: ${headers.join(', ')}):
${JSON.stringify(genericProduct, null, 2)}

This product has ${variantSummary.split('\n').length} variants (they differ ONLY in Color and/or Size):
${variantSummary}

CRITICAL RULES:
- The brand is EXACTLY "${brand}" — use this EXACT spelling, do NOT change it, do NOT abbreviate it, do NOT use a different brand name.
- The model is EXACTLY "${model}" — use this EXACT spelling.
- You are generating ONE shared template for ALL variants.
- The Title, Description, and Bullet Points MUST be 100% identical for every variant.
- NEVER mention any specific color, colour, shade, or size anywhere — not in the title, not in the description, not in the bullet points.
- I will append Color and Size to each variant's title myself.

TITLE FORMAT (use "|" as separator, NOT "-"):
[Brand] | [Model] | [Department/Target Audience] | [Product Type] | [Key Feature 1] | [Key Feature 2] | [Key Feature 3]

IMPORTANT: Do NOT include Color or Size in the title. I will append those myself per variant.
Example: "${brand} | ${model} | Men's | Safety Work Shoe | Composite Toe | Slip-Resistant | Water-Resistant"

TITLE RULES:
- Character limit: 80-200 characters (without color/size suffix).
- NO special characters: "!", "$", "?", "_", "{", "}", "^", "¬", "¦"
- NO promotional text: "free shipping", "guaranteed", "best seller", "hot item"
- Use numerals (2 instead of Two).
- Capitalize first letter of each word (except prepositions/conjunctions/articles).
- NO ALL CAPS.
- Use abbreviations: "cm", "oz", "in", "kg".

DESCRIPTION RULES:
- Concise, engaging, performance-focused. 150-300 words.
- MUST be generic — applies equally to ALL variants regardless of color or size.
- NEVER reference any specific color or size. Say "available in multiple colors and sizes" if needed.

BULLET POINTS RULES:
- Exactly 5 highly informative bullet points.
- MUST be generic — applies equally to ALL variants regardless of color or size.
- NEVER reference any specific color or size.
- Focus on: materials, safety features, comfort, certifications, use cases.

OUTPUT in both English (EN) and Arabic (AR). Arabic must be professional and optimized for GCC markets.
The Arabic description and bullets must also be 100% generic (no color/size references).

Return ONLY this JSON:
{
  "en": { "title": "...", "description": "...", "bulletPoints": ["...", "...", "...", "...", "..."] },
  "ar": { "title": "...", "description": "...", "bulletPoints": ["...", "...", "...", "...", "..."] }
}`;
}

/** Generate content for a product group (one API call per brand+model) */
export const generateGroupContent = async (
  representative: Record<string, any>,
  variants: Array<{ color: string; size: string }>,
  headers: string[]
): Promise<MarketplaceContent> => {
  const variantSummary = variants.map((v, i) =>
    `${i + 1}. Color: ${v.color || 'N/A'}, Size: ${v.size || 'N/A'}`
  ).join('\n');

  const prompt = buildGroupPrompt(representative, variantSummary, headers);

  const res = await fetch('/api/tools/gemini/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(errData.error || `Server error ${res.status}`);
  }

  const { text } = await res.json();

  try {
    const parsed = JSON.parse(text) as MarketplaceContent;
    if (!parsed?.en?.title || !parsed?.ar?.title) throw new Error("Missing required fields");
    return parsed;
  } catch (error) {
    console.error("Failed to parse AI response:", text);
    throw new Error("AI parse error: " + String(text).slice(0, 300));
  }
};

/** Apply variant-specific color/size to a group template */
export function applyVariant(template: MarketplaceContent, color: string, size: string): MarketplaceContent {
  const content: MarketplaceContent = JSON.parse(JSON.stringify(template));
  const suffix = [color, size ? `Size ${size}` : ''].filter(Boolean).join(' | ');
  if (suffix) {
    content.en.title = content.en.title + ' | ' + suffix;
    // For Arabic, append color/size in a consistent way
    const arSuffix = [color, size ? `مقاس ${size}` : ''].filter(Boolean).join(' | ');
    content.ar.title = content.ar.title + ' | ' + arSuffix;
  }
  return content;
}

/** Legacy single-product generate (for the individual Generate button) */
export const generateMarketplaceContent = async (productDetails: Record<string, any>): Promise<MarketplaceContent> => {
  const headers = Object.keys(productDetails);
  const color = getColor(productDetails);
  const size = getSize(productDetails);
  const template = await generateGroupContent(productDetails, [{ color, size }], headers);
  return applyVariant(template, color, size);
};
