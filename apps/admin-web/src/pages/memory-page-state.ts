export function isMemoryDialogCancellation(error: unknown): boolean {
  return error === 'cancel' || error === 'close';
}
