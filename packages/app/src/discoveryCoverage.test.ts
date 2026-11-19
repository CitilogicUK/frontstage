import { formatDiscoveryCoverage } from './discoveryCoverage';

it.each([
  [0, 0, undefined],
  [0, 2001, '0%'],
  [1, 2001, '<0.1%'],
  [1, 1000, '0.1%'],
  [199, 200, '99.5%'],
  [999, 1000, '99.9%'],
  [2000, 2001, '>99.9%'],
  [2001, 2001, '100%'],
])(
  'formats %i registered of %i eligible as %s',
  (registered, eligible, expected) => {
    expect(formatDiscoveryCoverage(registered, eligible)).toBe(expected);
  },
);
