import type { Connector } from './types.ts';
import { wikidataConnector } from './wikidata.ts';
import { zhaoConnector } from './zhao.ts';
import { usOfficialsConnector } from './us-officials.ts';
import { opensanctionsConnector } from './opensanctions.ts';
import { icijConnector } from './icij.ts';
import { wikidataXidsConnector } from './wikidata-xids.ts';
import { fecConnector } from './fec.ts';
import { littlesisConnector } from './littlesis.ts';

/** 连接器注册表：新增数据源时在这里登记 */
export const CONNECTORS: Record<string, Connector> = {
  [wikidataConnector.id]: wikidataConnector,
  [zhaoConnector.id]: zhaoConnector,
  [usOfficialsConnector.id]: usOfficialsConnector,
  [opensanctionsConnector.id]: opensanctionsConnector,
  [icijConnector.id]: icijConnector,
  [wikidataXidsConnector.id]: wikidataXidsConnector,
  [fecConnector.id]: fecConnector,
  [littlesisConnector.id]: littlesisConnector,
};

export type { Connector, ConnectorContext } from './types.ts';
