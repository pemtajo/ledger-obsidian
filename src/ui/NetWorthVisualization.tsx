import { makeAssetsAndLiabilitiesData, makeNetWorthData } from '../balance-utils';
import { Interval, makeBucketNames } from '../date-utils';
import { ISettings } from '../settings';
import { ILineChartOptions } from 'chartist';
import { Moment } from 'moment';
import React from 'react';
import ChartistGraph from 'react-chartist';
import styled from 'styled-components';

const Chart = styled.div`
  .ct-label {
    color: var(--text-muted);
  }

  // Series order below is [Net Worth, Total Assets, Total Liabilities].
  .ct-series-a .ct-line,
  .ct-series-a .ct-point {
    stroke: #e05252;
    stroke-width: 3px;
  }
  .ct-series-b .ct-line,
  .ct-series-b .ct-point {
    stroke: #4caf7d;
    stroke-width: 2px;
  }
  .ct-series-c .ct-line,
  .ct-series-c .ct-point {
    stroke: #e0b152;
    stroke-width: 2px;
  }
`;

const Legend = styled.ul`
  display: flex;
  gap: 1.5em;
  list-style: none;
  padding: 0;
  margin: 0.5em 0 0;

  li::before {
    content: '';
    display: inline-block;
    width: 0.75em;
    height: 0.75em;
    border-radius: 50%;
    margin-right: 0.4em;
  }
  li.ct-series-a::before {
    background: #e05252;
  }
  li.ct-series-b::before {
    background: #4caf7d;
  }
  li.ct-series-c::before {
    background: #e0b152;
  }
`;

const formatBRL = (value: number): string =>
  'R$' +
  Math.round(value).toLocaleString('pt-BR', {
    maximumFractionDigits: 0,
  });

export const NetWorthVisualization: React.FC<{
  dailyAccountBalanceMap: Map<string, Map<string, number>>;
  startDate: Moment;
  endDate: Moment;
  interval: Interval;
  settings: ISettings;
}> = (props): JSX.Element => {
  const dateBuckets = makeBucketNames(
    props.interval,
    props.startDate,
    props.endDate,
  );

  const netWorth = makeNetWorthData(
    props.dailyAccountBalanceMap,
    dateBuckets,
    props.settings,
  );
  const { assets, liabilities } = makeAssetsAndLiabilitiesData(
    props.dailyAccountBalanceMap,
    dateBuckets,
    props.settings,
  );

  const data = {
    labels: dateBuckets,
    series: [netWorth, assets, liabilities],
  };

  const options: ILineChartOptions = {
    height: '300px',
    width: '100%',
    showArea: false,
    showPoint: true,
    low: 0,
    axisY: {
      labelInterpolationFnc: formatBRL,
    },
  };

  const type = 'Line';
  return (
    <>
      <h2>Net Worth</h2>
      <i>Assets minus liabilities, all in R$</i>

      <Legend>
        <li className="ct-series-a">Net Worth</li>
        <li className="ct-series-b">Total Assets</li>
        <li className="ct-series-c">Total Liabilities</li>
      </Legend>

      <Chart>
        <ChartistGraph data={data} options={options} type={type} />
      </Chart>
    </>
  );
};
