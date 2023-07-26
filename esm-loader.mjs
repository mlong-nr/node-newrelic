/*
 * Copyright 2022 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import newrelic from './index.js'
import shimmer from './lib/shimmer.js'
import loggingModule from './lib/logger.js'
import NAMES from './lib/metrics/names.js'
import semver from 'semver'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const isSupportedVersion = () => semver.gte(process.version, 'v16.12.0')
// This check will prevent resolve hooks executing from within this file
// If I do `import('foo')` in here it'll hit the resolve hook multiple times
const isFromEsmLoader = (context) =>
  context && context.parentURL && context.parentURL.includes('newrelic/esm-loader.mjs')

const logger = loggingModule.child({ component: 'esm-loader' })
const esmShimPath = new URL('./lib/esm-shim.mjs', import.meta.url)
const customEntryPoint = newrelic?.agent?.config?.api.esm.custom_instrumentation_entrypoint
const __filename = fileURLToPath(import.meta.url)

// Hook point within agent for customers to register their custom instrumentation.
if (customEntryPoint) {
  const resolvedEntryPoint = path.resolve(customEntryPoint)
  logger.debug('Registering custom ESM instrumentation at %s', resolvedEntryPoint)
  await import(resolvedEntryPoint)
}

addESMSupportabilityMetrics(newrelic.agent)

// exporting for testing purposes
export const registeredSpecifiers = new Map()
let preloadPort

// TODO: move this function to its own file so it can be used
// in the test harness too since you cannot chain globalPreload hooks
export function globalPreload({ port }) {
  preloadPort = port

  return `
    const { createRequire } = getBuiltin('module')
    const path = getBuiltin('path')
    const { cwd } = getBuiltin('process')
    const require = createRequire(${JSON.stringify(__filename)})
    // load agent in main thread
    const newrelic = require('./index')
    const shimmer = require('./lib/shimmer.js')
    const loggingModule = require('./lib/logger.js')
    const logger = loggingModule.child({ component: 'esm-loader' })
    // Have to do this in function as top level await does not work
    /* How to load this cuz import does not seem to work
    const customEntryPoint = newrelic?.agent?.config?.api.esm.custom_instrumentation_entrypoint
    // Hook point within agent for customers to register their custom instrumentation.
    async function loadCustomEntryPoint() {
      if (customEntryPoint) {
        logger.debug('Registering custom ESM instrumentation at %s', customEntryPoint)
        await import(customEntryPoint)
        //require(resolvedEntryPoint)
      }
    }
    loadCustomEntryPoint()
    */

    port.onmessage = ({ data: { details } }) => {
      const { specifier, resolvedModule, filePath } = details
      const instrumentationName = shimmer.getInstrumentationNameFromModuleName(specifier)
      const instrumentationDefinition = shimmer.registeredInstrumentations[instrumentationName]
      if (instrumentationDefinition) {
        // ES Modules translate import statements into fully qualified filepaths, so we create a copy of our instrumentation under this filepath
        const instrumentationDefinitionCopy = [...instrumentationDefinition]

        instrumentationDefinitionCopy.forEach((copy) => {
          // Stripping the prefix is necessary because the code downstream gets this url without it
          copy.moduleName = filePath 

          // Added to keep our Supportability metrics from exploding/including customer info via full filepath
          copy.specifier = specifier
          shimmer.registerInstrumentation(copy)
          logger.debug(
            'Registered CommonJS instrumentation for ' + specifier + ' under ' + copy.moduleName
          )
        })
      }
    };
    `
}

/**
 * Hook chain responsible for resolving a file URL for a given module specifier
 *
 * Our loader has to be the last user-supplied loader if chaining is happening,
 * as we rely on `nextResolve` being the default Node.js resolve hook to get our URL
 *
 * Docs: https://nodejs.org/api/esm.html#resolvespecifier-context-nextresolve
 *
 * @param {string} specifier string identifier in an import statement or import() expression
 * @param {object} context metadata about the specifier, including url of the parent module and any import assertions
 *        Optional argument that only needs to be passed when changed
 * @param {Function} nextResolve The subsequent resolve hook in the chain, or the Node.js default resolve hook after the last user-supplied resolve hook
 * @returns {Promise} Promise object representing the resolution of a given specifier
 */
export async function resolve(specifier, context, nextResolve) {
  if (!newrelic.agent || !isSupportedVersion() || isFromEsmLoader(context)) {
    return nextResolve(specifier, context, nextResolve)
  }

  /**
   * We manually call the default Node.js resolve hook so
   * that we can get the fully qualified URL path and the
   * package type (commonjs/module/builtin) without
   * duplicating the logic of the Node.js hook
   */
  const resolvedModule = await nextResolve(specifier, context, nextResolve)
  const { url, format } = resolvedModule
  if (registeredSpecifiers.get(url)) {
    logger.debug(
      `Instrumentation already registered for ${specifier} under ${fileURLToPath(
        url
      )}, skipping resolve hook...`
    )
  } else if (format === 'module') {
    const instrumentationName = shimmer.getInstrumentationNameFromModuleName(specifier)
    const instrumentationDefinition = shimmer.registeredInstrumentations[instrumentationName]
    if (instrumentationDefinition) {
      registeredSpecifiers.set(url, { specifier, hasNrInstrumentation: true })
    }
  } else if (format === 'commonjs') {
    const filePath = fileURLToPath(url)
    const details = { specifier, resolvedModule, filePath }
    // fire and forget message to parent as it'll be updated
    // before the loader finishes for all imports
    preloadPort.postMessage({ details })
  }

  return resolvedModule
}

/**
 * Hook chain responsible for determining how a URL should be interpreted, retrieved, and parsed.
 *
 * Our loader has to be the last user-supplied loader if chaining is happening,
 * as we rely on `nextLoad` being the default Node.js resolve hook to load the ESM.
 *
 * Docs: https://nodejs.org/dist/latest-v18.x/docs/api/esm.html#loadurl-context-nextload
 *
 * @param {string} url the URL returned by the resolve chain
 * @param {object} context metadata about the url, including conditions, format and import assertions
 * @param {Function} nextLoad the subsequent load hook in the chain, or the Node.js default load hook after the last user-supplied load hook
 * @returns {Promise} Promise object representing the load of a given url
 */
export async function load(url, context, nextLoad) {
  if (!newrelic.agent || !isSupportedVersion()) {
    return nextLoad(url, context, nextLoad)
  }

  const seenUrl = registeredSpecifiers.get(url)
  if (!seenUrl || !seenUrl.hasNrInstrumentation) {
    return nextLoad(url, context, nextLoad)
  }

  const { specifier } = seenUrl
  const rewrittenSource = await wrapEsmSource(url, specifier)
  logger.debug(`Registered module instrumentation for ${specifier}.`)

  return {
    format: 'module',
    source: rewrittenSource,
    shortCircuit: true
  }
}

/**
 * Helper function for determining which of our Supportability metrics to use for the current loader invocation
 *
 * @param {object} agent
 *        instantiation of the New Relic agent
 * @returns {void}
 */
function addESMSupportabilityMetrics(agent) {
  if (!agent) {
    return
  }

  if (isSupportedVersion()) {
    agent.metrics.getOrCreateMetric(NAMES.FEATURES.ESM.LOADER).incrementCallCount()
  } else {
    logger.warn(
      'New Relic for Node.js ESM loader requires a version of Node >= v16.12.0; your version is %s.  Instrumentation will not be registered.',
      process.version
    )
    agent.metrics.getOrCreateMetric(NAMES.FEATURES.ESM.UNSUPPORTED_LOADER).incrementCallCount()
  }

  if (customEntryPoint) {
    agent.metrics.getOrCreateMetric(NAMES.FEATURES.ESM.CUSTOM_INSTRUMENTATION).incrementCallCount()
  }
}

/**
 * Rewrites the source code of a ES module we want to instrument.
 * This is done by injecting the ESM shim which proxies every property on the exported
 * module and registers the module with shimmer so instrumentation can be registered properly.
 *
 * Note: this autogenerated code _requires_ that the import have the file:// prefix!
 * Without it, Node.js throws an ERR_INVALID_URL error: you've been warned.
 *
 * @param {string} url the URL returned by the resolve chain
 * @param {string} specifier string identifier in an import statement or import() expression
 * @returns {string} source code rewritten to wrap with our esm-shim
 */
async function wrapEsmSource(url, specifier) {
  const pkg = await import(url)
  const props = Object.keys(pkg)
  const trimmedUrl = fileURLToPath(url)

  return `
    import wrapModule from '${esmShimPath.href}'
    import * as _originalModule from '${url}'
    const _wrappedModule = wrapModule(_originalModule, '${specifier}', '${trimmedUrl}')
    ${props
      .map((propName) => {
        return `
    let _${propName} = _wrappedModule.${propName}
    export { _${propName} as ${propName} }`
      })
      .join('\n')}
  `
}
