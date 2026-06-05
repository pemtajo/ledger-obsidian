import LedgerPlugin from './main';
import { AddExpenseModal, Operation } from './modals';
import { EnhancedTransaction, parse, TransactionCache } from './parser';
import type { ISettings } from './settings';
import type { MetadataCache, TFile, Vault } from 'obsidian';

export class LedgerModifier {
  private readonly plugin: LedgerPlugin;
  private ledgerFile: TFile;

  constructor(plugin: LedgerPlugin, ledgerFile: TFile) {
    this.plugin = plugin;
    this.ledgerFile = ledgerFile;
  }

  public setLedgerFile(ledgerFile: TFile): void {
    this.ledgerFile = ledgerFile;
  }

  public openExpenseModal(
    operation: Operation,
    initialState?: EnhancedTransaction,
  ): void {
    new AddExpenseModal(this.plugin, this, operation, initialState).open();
  }

  public async updateTransaction(
    oldTx: EnhancedTransaction,
    newTx: string,
  ): Promise<void> {
    const vault = this.plugin.app.vault;
    const fileContents = await vault.cachedRead(this.ledgerFile);
    const lines = fileContents.split('\n');
    const newLines =
      lines.slice(0, oldTx.block.firstLine).join('\n') +
      newTx +
      '\n' +
      lines.slice(oldTx.block.lastLine + 1).join('\n');
    return vault.modify(this.ledgerFile, newLines);
  }

  public async deleteTransaction(tx: EnhancedTransaction): Promise<void> {
    const vault = this.plugin.app.vault;
    const fileContents = await vault.cachedRead(this.ledgerFile);
    const lines = fileContents.split('\n');
    let length = tx.block.lastLine - tx.block.firstLine + 1;
    if (lines[tx.block.firstLine + length] === '') {
      length++; // Attempt to prevent a double blank line
    }
    lines.splice(tx.block.firstLine, length);
    return vault.modify(this.ledgerFile, lines.join('\n'));
  }

  public async appendLedger(newExpense: string): Promise<void> {
    const vault = this.plugin.app.vault;
    const fileContents = await vault.read(this.ledgerFile);
    const newFileContents = `${fileContents}\n${newExpense}`;
    await vault.modify(this.ledgerFile, newFileContents);
  }
}

export const getTransactionCache = async (
  cache: MetadataCache,
  vault: Vault,
  settings: ISettings,
  ledgerFilePath: string,
): Promise<TransactionCache> => {
  const file = cache.getFirstLinkpathDest(ledgerFilePath, '');
  if (!file) {
    throw new Error('Ledger: Unable to find Ledger file to parse');
  }

  let fileContents = await vault.read(file);

  // BRL preprocessing: when a prices.db is configured and readable, rewrite
  // every posting to its BRL equivalent so the parser only ever sees R$
  // amounts. Failure is non-fatal — the dashboard falls back to raw mixed-
  // currency display, same as before this feature existed.
  if (settings.pricesDBFile) {
    try {
      const pricesFile = cache.getFirstLinkpathDest(settings.pricesDBFile, '');
      if (pricesFile) {
        const pricesContent = await vault.read(pricesFile);
        const { parsePricesDB, preprocessLedger } = await import('./prices');
        const priceIndex = parsePricesDB(pricesContent);
        fileContents = preprocessLedger(fileContents, priceIndex);
      } else {
        console.warn(
          `Ledger: prices DB not found at "${settings.pricesDBFile}" — skipping BRL conversion`,
        );
      }
    } catch (err) {
      console.warn('Ledger: failed to apply BRL preprocessing', err);
    }
  }

  return parse(fileContents, settings);
};
