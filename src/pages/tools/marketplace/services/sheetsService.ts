export interface SheetRow {
  [key: string]: any;
}

export class SheetsService {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async fetch(url: string, options: RequestInit = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `HTTP error! status: ${res.status}`);
    }

    return res.json();
  }

  async getSpreadsheet(spreadsheetId: string) {
    return this.fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`);
  }

  async getValues(spreadsheetId: string, range: string) {
    const data = await this.fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`);
    return data.values as any[][];
  }

  async updateValues(spreadsheetId: string, range: string, values: any[][]) {
    return this.fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      body: JSON.stringify({ values }),
    });
  }

  async appendValues(spreadsheetId: string, range: string, values: any[][]) {
    return this.fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`, {
      method: 'POST',
      body: JSON.stringify({ values }),
    });
  }

  async createSheet(spreadsheetId: string, title: string) {
    return this.fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: { title },
            },
          },
        ],
      }),
    });
  }

  static parseSheetData(values: any[][]): SheetRow[] {
    if (!values || values.length < 1) return [];
    const headers = values[0];
    return values.slice(1).map((row) => {
      const item: SheetRow = {};
      headers.forEach((header, index) => {
        item[header] = row[index];
      });
      return item;
    });
  }
}
