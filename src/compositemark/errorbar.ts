import {Config} from '../config';
import {PositionFieldDef} from '../fielddef';
import {isMarkDef} from '../mark';
import {AggregatedFieldDef, CalculateTransform, Transform} from '../transform';
import {Flag, keys} from '../util';
import {Encoding, extractTransformsFromEncoding} from './../encoding';
import * as log from './../log';
import {GenericUnitSpec, NormalizedLayerSpec} from './../spec';
import {Orient} from './../vega.schema';
import {
  compositeMarkContinuousAxis,
  compositeMarkOrient,
  filterUnsupportedChannels,
  GenericCompositeMarkDef,
  makeCompositeAggregatePartFactory,
} from './common';
import {PartsMixins} from './common';
import {ErrorBand, ErrorBandDef} from './errorband';

export const ERRORBAR: 'errorbar' = 'errorbar';
export type ErrorBar = typeof ERRORBAR;

export type ErrorBarExtent = 'ci' | 'iqr' | 'stderr' | 'stdev';
export type ErrorBarCenter = 'mean' | 'median';

export type ErrorBarPart = 'ticks' | 'rule';

const ERRORBAR_PART_INDEX: Flag<ErrorBarPart> = {
  ticks: 1,
  rule: 1
};

export const ERRORBAR_PARTS = keys(ERRORBAR_PART_INDEX);

export type ErrorBarPartsMixins = PartsMixins<ErrorBarPart>;

export interface ErrorBarConfig extends ErrorBarPartsMixins {
  /**
   * The center of the errorbar. Available options include:
   * - `"mean": the mean of the data points.
   * - `"median": the median of the data points.
   *
   * __Default value:__ `"mean"`.
   */
  center?: ErrorBarCenter;

  /**
   * The extent of the rule. Available options include:
   * - `"ci": Extend the rule to the confidence interval of the mean.
   * - `"stderr": The size of rule are set to the value of standard error, extending from the center.
   * - `"stdev": The size of rule are set to the value of standard deviation, extending from the center.
   * - `"iqr": Extend the rule to the q1 and q3.
   *
   * __Default value:__ `"stderr"`.
   */
  extent?: ErrorBarExtent;
}

export type ErrorBarDef = GenericCompositeMarkDef<ErrorBar> & ErrorBarConfig & {
  /**
   * Orientation of the error bar.  This is normally automatically determined, but can be specified when the orientation is ambiguous and cannot be automatically determined.
   */
  orient?: Orient;
};

export interface ErrorBarConfigMixins {
  /**
   * ErrorBar Config
   */
  errorbar?: ErrorBarConfig;
}

export function normalizeErrorBar(spec: GenericUnitSpec<Encoding<string>, ErrorBar | ErrorBarDef>, config: Config): NormalizedLayerSpec {
  spec = filterUnsupportedChannels(spec, ERRORBAR);

  // TODO: use selection
  const {mark, encoding, selection, projection: _p, ...outerSpec} = spec;
  const markDef: ErrorBarDef = isMarkDef(mark) ? mark : {type: mark};

  const {transform, continuousAxisChannelDef, continuousAxis, encodingWithoutContinuousAxis} = errorBarParams(spec, markDef, ERRORBAR, config);

  const makeErrorBarPart = makeCompositeAggregatePartFactory<ErrorBarPartsMixins>(
      markDef,
      continuousAxis,
      continuousAxisChannelDef,
      encodingWithoutContinuousAxis,
      config.errorbar
  );

  return {
    ...outerSpec,
    transform,
    layer: [
      ...makeErrorBarPart('ticks', 'tick', 'lower'),
      ...makeErrorBarPart('ticks', 'tick', 'upper'),
      ...makeErrorBarPart('rule', 'rule', 'lower', 'upper')
    ]
  };
}

export function errorBarParams<M extends ErrorBar | ErrorBand, MD extends GenericCompositeMarkDef<M> & (ErrorBarDef | ErrorBandDef)>(
  spec: GenericUnitSpec<Encoding<string>, M | MD>,
  markDef: MD,
  compositeMark: M,
  config: Config
): {
  transform: Transform[];
  groupby: string[];
  continuousAxisChannelDef: PositionFieldDef<string>;
  continuousAxis: 'x' | 'y';
  encodingWithoutContinuousAxis: Encoding<string>
} {
  // TODO(https://github.com/vega/vega-lite/issues/3702): add selection support
  if (spec.selection) {
    log.warn(log.message.selectionNotSupported(compositeMark));
  }

  const center: ErrorBarCenter = markDef.center || config.errorbar.center;
  const extent: ErrorBarExtent = markDef.extent || ((center === 'mean') ? 'stderr' : 'iqr');

  if ((center === 'median') !== (extent === 'iqr')) {
    log.warn(`${center} is not usually used with ${extent} for ${compositeMark}.`);
  }

  const orient: Orient = compositeMarkOrient(spec, compositeMark);
  const {continuousAxisChannelDef, continuousAxis} = compositeMarkContinuousAxis(spec, orient, compositeMark);
  const continuousFieldName: string = continuousAxisChannelDef.field;
  let errorbarSpecificAggregate: AggregatedFieldDef[] = [];
  let postAggregateCalculates: CalculateTransform[] = [];

  if (extent === 'stderr' || extent === 'stdev') {
    errorbarSpecificAggregate = [{
      op: extent,
      field: continuousFieldName,
      as: 'extent_' + continuousFieldName
    }];

    postAggregateCalculates = [{
        calculate: `datum.${center}_${continuousFieldName} + datum.extent_${continuousFieldName}`,
        as: 'upper_' + continuousFieldName
      },
      {
        calculate: `datum.${center}_${continuousFieldName} - datum.extent_${continuousFieldName}`,
        as: 'lower_' + continuousFieldName
    }];
  } else {
    errorbarSpecificAggregate = [
      {
        op: (extent === 'ci') ? 'ci0' : 'q1',
        field: continuousFieldName,
        as: 'lower_' + continuousFieldName
      },
      {
        op: (extent === 'ci') ? 'ci1' : 'q3',
        field: continuousFieldName,
        as: 'upper_' + continuousFieldName
      }
    ];
  }

  errorbarSpecificAggregate.push({
    op: center,
    field: continuousFieldName,
    as: center + '_' + continuousFieldName
  });

  const {[continuousAxis]: oldContinuousAxisChannelDef, ...oldEncodingWithoutContinuousAxis} = spec.encoding;

  const {bins, timeUnits, aggregate, groupby, encoding: encodingWithoutContinuousAxis} = extractTransformsFromEncoding(oldEncodingWithoutContinuousAxis);

  return {
    transform: [
      ...bins,
      ...timeUnits,
      {
        aggregate: [...aggregate, ...errorbarSpecificAggregate],
        groupby
      },
      ...postAggregateCalculates
    ],
    groupby,
    continuousAxisChannelDef,
    continuousAxis,
    encodingWithoutContinuousAxis
  };
}
