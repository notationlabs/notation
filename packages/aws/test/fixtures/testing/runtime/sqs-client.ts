export const sent: Array<{ url: string; body: string }> = [];

export async function sendMessage(url: string, body: string) {
  sent.push({ url, body });
}
