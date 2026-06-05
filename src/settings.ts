const defaultSettings: ISettings = {
  tutorialIndex: -1,

  currencySymbol: 'R$',
  ledgerFile: 'ourun/finances/Ledger.ledger',
  pricesDBFile: 'ourun/finances/prices.db',

  assetAccountsPrefix: 'assets',
  expenseAccountsPrefix: 'expenses',
  incomeAccountsPrefix: 'income',
  liabilityAccountsPrefix: 'liabilities',
};

export interface ISettings {
  tutorialIndex: number;

  currencySymbol: string;
  ledgerFile: string;
  /**
   * Optional path to a ledger-cli price database. When set and readable,
   * every posting is converted to BRL using these prices before the parser
   * sees it — so dashboards always show R$ regardless of mixed currencies
   * or share-count commodities in the source file.
   */
  pricesDBFile: string;

  assetAccountsPrefix: string;
  expenseAccountsPrefix: string;
  incomeAccountsPrefix: string;
  liabilityAccountsPrefix: string;
}

export const settingsWithDefaults = (
  settings: Partial<ISettings>,
): ISettings => ({
  ...defaultSettings,
  ...settings,
});
