/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'jest',
  reporters: ['clear-text', 'progress'],
  coverageAnalysis: 'perTest',
  mutate: [
    'src/common/cpf.utils.ts',
    'src/income/income.date-utils.ts',
    'src/common/filters/all-exceptions.filter.ts',
    'src/balance/balance.service.ts',
    'src/expenses/expenses.service.ts',
    'src/family/family.service.ts',
  ],
  jest: {
    projectType: 'custom',
    configFile: 'package.json',
    enableFindRelatedTests: true,
  },
  thresholds: {
    high: 80,
    low: 65,
    break: null,
  },
  concurrency: 4,
  timeoutMS: 15000,
};
