/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as api from '@opentelemetry/api';
/** @knipignore */
import { PACKAGE_NAME, PACKAGE_VERSION } from './version';
import * as constants from './constants';
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  isWrapped,
} from '@opentelemetry/instrumentation';
import {
  SEMATTRS_DB_NAME,
  SEMATTRS_DB_OPERATION,
  SEMATTRS_DB_SQL_TABLE,
  SEMATTRS_DB_STATEMENT,
  SEMATTRS_DB_SYSTEM,
  SEMATTRS_DB_USER,
  SEMATTRS_NET_PEER_NAME,
  SEMATTRS_NET_PEER_PORT,
  SEMATTRS_NET_TRANSPORT,
} from '@opentelemetry/semantic-conventions';
import * as utils from './utils';
import { KnexInstrumentationConfig } from './types';

const contextSymbol = Symbol('opentelemetry.instrumentation-knex.context');
const DEFAULT_CONFIG: KnexInstrumentationConfig = {
  maxQueryLength: 1022,
  requireParentSpan: false,
};

export class KnexInstrumentation extends InstrumentationBase<KnexInstrumentationConfig> {
  constructor(config: KnexInstrumentationConfig = {}) {
    super(PACKAGE_NAME, PACKAGE_VERSION, { ...DEFAULT_CONFIG, ...config });
  }

  override setConfig(config: KnexInstrumentationConfig = {}) {
    super.setConfig({ ...DEFAULT_CONFIG, ...config });
  }

  init() {
    const module = new InstrumentationNodeModuleDefinition(
      constants.MODULE_NAME,
      constants.SUPPORTED_VERSIONS
    );

    module.files.push(
      this.getClientNodeModuleFileInstrumentation('src'),
      this.getClientNodeModuleFileInstrumentation('lib'),
      this.getRunnerNodeModuleFileInstrumentation('src'),
      this.getRunnerNodeModuleFileInstrumentation('lib'),
      this.getRunnerNodeModuleFileInstrumentation('lib/execution')
    );

    return module;
  }

  private getRunnerNodeModuleFileInstrumentation(basePath: string) {
    return new InstrumentationNodeModuleFile(
      `knex/${basePath}/runner.js`,
      constants.SUPPORTED_VERSIONS,
      (Runner: any, moduleVersion) => {
        this.ensureWrapped(
          Runner.prototype,
          'query',
          this.createQueryWrapper(moduleVersion)
        );
        return Runner;
      },
      (Runner: any, moduleVersion) => {
        this._unwrap(Runner.prototype, 'query');
        return Runner;
      }
    );
  }

  private getClientNodeModuleFileInstrumentation(basePath: string) {
    return new InstrumentationNodeModuleFile(
      `knex/${basePath}/client.js`,
      constants.SUPPORTED_VERSIONS,
      (Client: any) => {
        this.ensureWrapped(
          Client.prototype,
          'queryBuilder',
          this.storeContext.bind(this)
        );
        this.ensureWrapped(
          Client.prototype,
          'schemaBuilder',
          this.storeContext.bind(this)
        );
        this.ensureWrapped(
          Client.prototype,
          'raw',
          this.storeContext.bind(this)
        );
        return Client;
      },
      (Client: any) => {
        this._unwrap(Client.prototype, 'queryBuilder');
        this._unwrap(Client.prototype, 'schemaBuilder');
        this._unwrap(Client.prototype, 'raw');
        return Client;
      }
    );
  }

  private createQueryWrapper(moduleVersion?: string) {
    const instrumentation = this;
    return function wrapQuery(original: (...args: any[]) => any) {
      return function wrapped_logging_method(this: any, query: any) {
        const config = this.client.config;

        const table = utils.extractTableName(this.builder);
        // `method` actually refers to the knex API method - Not exactly "operation"
        // in the spec sense, but matches most of the time.
        const operation = query?.method;
        const name =
          config?.connection?.filename || config?.connection?.database;
        const { maxQueryLength } = instrumentation.getConfig();

        const attributes: api.SpanAttributes = {
          'knex.version': moduleVersion,
          [SEMATTRS_DB_SYSTEM]: utils.mapSystem(config.client),
          [SEMATTRS_DB_SQL_TABLE]: table,
          [SEMATTRS_DB_OPERATION]: operation,
          [SEMATTRS_DB_USER]: config?.connection?.user,
          [SEMATTRS_DB_NAME]: name,
          [SEMATTRS_NET_PEER_NAME]: config?.connection?.host,
          [SEMATTRS_NET_PEER_PORT]: config?.connection?.port,
          [SEMATTRS_NET_TRANSPORT]:
            config?.connection?.filename === ':memory:' ? 'inproc' : undefined,
        };
        if (maxQueryLength) {
          // filters both undefined and 0
          attributes[SEMATTRS_DB_STATEMENT] = utils.limitLength(
            query?.sql,
            maxQueryLength
          );
        }

        const parentContext =
          this.builder[contextSymbol] || api.context.active();
        const parentSpan = api.trace.getSpan(parentContext);
        const hasActiveParent =
          parentSpan && api.trace.isSpanContextValid(parentSpan.spanContext());
        if (instrumentation._config.requireParentSpan && !hasActiveParent) {
          return original.bind(this)(...arguments);
        }

        const span = instrumentation.tracer.startSpan(
          utils.getName(name, operation, table),
          {
            kind: api.SpanKind.CLIENT,
            attributes,
          },
          parentContext
        );
        const spanContext = api.trace.setSpan(api.context.active(), span);

        return api.context
          .with(spanContext, original, this, ...arguments)
          .then((result: unknown) => {
            span.end();
            return result;
          })
          .catch((err: any) => {
            // knex adds full query with all the binding values to the message,
            // we want to undo that without changing the original error
            const formatter = utils.getFormatter(this);
            const fullQuery = formatter(query.sql, query.bindings || []);
            const message = err.message.replace(fullQuery + ' - ', '');
            const exc = utils.otelExceptionFromKnexError(err, message);
            span.recordException(exc);
            span.setStatus({ code: api.SpanStatusCode.ERROR, message });
            span.end();
            throw err;
          });
      };
    };
  }

  private storeContext(original: Function) {
    return function wrapped_logging_method(this: any) {
      const builder = original.apply(this, arguments);
      // Builder is a custom promise type and when awaited it fails to propagate context.
      // We store the parent context at the moment of initiating the builder
      // otherwise we'd have nothing to attach the span as a child for in `query`.
      Object.defineProperty(builder, contextSymbol, {
        value: api.context.active(),
      });
      return builder;
    };
  }

  ensureWrapped(obj: any, methodName: string, wrapper: (original: any) => any) {
    if (isWrapped(obj[methodName])) {
      this._unwrap(obj, methodName);
    }
    this._wrap(obj, methodName, wrapper);
  }
}
