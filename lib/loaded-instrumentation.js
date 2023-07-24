const pkgs = Object.create(null)
function registerInstrumentation(opts) {
  if (!hasValidRegisterOptions(opts)) {
    return
  }

  const registeredInstrumentation = pkgs[opts.moduleName]

  if (!registeredInstrumentation) {
    pkgs[opts.moduleName] = []
  }

  pkgs[opts.moduleName].push({ ...opts })
}

function hasValidRegisterOptions(opts) {
  if (!opts) {
    //logger.warn('Instrumentation registration failed, no options provided')
    return false
  }

  if (!opts.moduleName) {
    //logger.warn(`Instrumentation registration failed, 'moduleName' not provided`)
    return false
  }

  if (!opts.onRequire && !opts.onResolved) {
    /*logger.warn(
      'Instrumentation registration for %s failed, no require hooks provided.',
      opts.moduleName
    )
    */

    return false
  }

  return true
}


module.exports = {
  pkgs,
  registerInstrumentation
}
