import { debug, getInput, setFailed, type InputOptions } from '@actions/core'
import { GITHUB_COM_API_URL, GITHUB_COM_SERVER_URL, buildPiperFromSource, downloadPiperBinary } from './github'
import { chmodSync } from 'fs'
import { executePiper } from './execute'
import { getDefaultConfig, readContextConfig, createCheckIfStepActiveMaps } from './config'
import { loadPipelineEnv, exportPipelineEnv } from './pipelineEnv'
import { cleanupContainers, runContainers } from './docker'
import { isEnterpriseStep, onGitHubEnterprise } from './enterprise'

// Global runtime variables that is accessible within a single action execution
export const internalActionVariables = {
  piperBinPath: '',
  dockerContainerID: '',
  sidecarNetworkID: '',
  sidecarContainerID: ''
}

export async function run (): Promise<void> {
  try {
    const actionCfg = await getActionConfig({ required: false })
    await preparePiperBinary(actionCfg)

    await loadPipelineEnv()
    await executePiper('version')
    if (onGitHubEnterprise()) {
      await getDefaultConfig(actionCfg.gitHubEnterpriseServer, actionCfg.gitHubEnterpriseToken, actionCfg.sapPiperOwner, actionCfg.sapPiperRepo, actionCfg.customDefaultsPaths)
    }
    if (actionCfg.createCheckIfStepActiveMaps) {
      await createCheckIfStepActiveMaps(actionCfg.gitHubEnterpriseToken, actionCfg.sapPiperOwner, actionCfg.sapPiperRepo)
    }
    if (actionCfg.stepName !== '') {
      const flags = actionCfg.flags.split(' ')
      const contextConfig = await readContextConfig(actionCfg.stepName, flags)
      await runContainers(actionCfg, contextConfig)
      await executePiper(actionCfg.stepName, flags)
    }
    await exportPipelineEnv(actionCfg.exportPipelineEnvironment)
  } catch (error: unknown) {
    setFailed((() => {
      if (error instanceof Error) {
        return error.message
      }
      return String(error)
    })())
  } finally {
    await cleanupContainers()
  }
}

async function preparePiperBinary (actionCfg: ActionConfiguration): Promise<void> {
  let piperPath
  if (isEnterpriseStep(actionCfg.stepName)) {
    piperPath = await downloadPiperBinary(actionCfg.stepName, actionCfg.sapPiperVersion, actionCfg.gitHubEnterpriseApi, actionCfg.gitHubEnterpriseToken, actionCfg.sapPiperOwner, actionCfg.sapPiperRepo)
  } else if (actionCfg.piperVersion.startsWith('devel:')) {
    piperPath = await buildPiperFromSource(actionCfg.piperVersion)
  } else {
    piperPath = await downloadPiperBinary(actionCfg.stepName, actionCfg.piperVersion, actionCfg.gitHubApi, actionCfg.gitHubToken, actionCfg.piperOwner, actionCfg.piperRepo)
  }
  if (piperPath === undefined || piperPath === '') {
    throw new Error('Piper binary path is empty. Please check your action inputs.')
  }

  internalActionVariables.piperBinPath = piperPath
  debug('obtained piper binary at '.concat(piperPath))
  chmodSync(piperPath, 0o775)
}

export interface PiperBinary {
  binaryName: string
  version: string
  owner: string
  repository: string
  gitHubServer: string
  gitHubApi: string
  gitHubToken: string
}

export interface ActionConfiguration {
  piper: PiperBinary
  sapPiper: PiperBinary
  stepName: string
  flags: string
  dockerImage: string
  dockerOptions: string
  dockerEnvVars: string
  sidecarImage: string
  sidecarOptions: string
  sidecarEnvVars: string
  retrieveDefaultConfig: boolean
  customDefaultsPaths: string
  createCheckIfStepActiveMaps: boolean
  exportPipelineEnvironment: boolean
}

async function getActionConfig (options: InputOptions): Promise<ActionConfiguration> {
  const getValue = (param: string, defaultValue?: string): string => {
    let value: string = getInput(param, options)
    if (value === '') {
      // EnVs should be provided like this
      // PIPER_ACTION_DOWNLOAD_URL
      value = process.env[`PIPER_ACTION_${param.toUpperCase().replace(/-/g, '_')}`] ?? ''
      if (value === '') {
        if (defaultValue !== undefined) {
          return defaultValue
        }
        return ''
      }
    }
    debug(`${param}: ${value}`)
    return value
  }
  let enterpriseHost: string = ''
  let enterpriseApi: string = ''
  if (onGitHubEnterprise()) {
    if (process.env.GITHUB_SERVER_URL !== undefined) {
      enterpriseHost = process.env.GITHUB_SERVER_URL
    }
    if (process.env.GITHUB_API_URL !== undefined) {
      enterpriseApi = process.env.GITHUB_API_URL
    }
  }

  let stepNameValue = getValue('step-name')
  // TODO: remove command input
  if (stepNameValue === undefined || stepNameValue === '') {
    stepNameValue = getValue('command')
  }

  return {
    piper: {
      binaryName: 'piper',
      version: getValue('piper-version'),
      owner: getValue('piper-owner', PIPER_OWNER),
      repository: getValue('piper-repository', PIPER_REPOSITORY),
      gitHubServer: GITHUB_COM_SERVER_URL,
      gitHubApi: GITHUB_COM_API_URL,
      gitHubToken: getValue('github-token')
    },
    sapPiper: {
      binaryName: 'sapPiper',
      version: getValue('sap-piper-version'),
      owner: getValue('sap-piper-owner'),
      repository: getValue('sap-piper-repository'),
      gitHubServer: enterpriseHost,
      gitHubApi: enterpriseApi,
      gitHubToken: getValue('github-enterprise-token')
    },
    stepName: stepNameValue,
    flags: getValue('flags'),
    dockerImage: getValue('docker-image'),
    dockerOptions: getValue('docker-options'),
    dockerEnvVars: getValue('docker-env-vars'),
    sidecarImage: getValue('sidecar-image'),
    sidecarOptions: getValue('sidecar-options'),
    sidecarEnvVars: getValue('sidecar-env-vars'),
    retrieveDefaultConfig: getValue('retrieve-default-config') === 'true',
    customDefaultsPaths: getValue('custom-defaults-paths'),
    createCheckIfStepActiveMaps: getValue('create-check-if-step-active-maps') === 'true',
    exportPipelineEnvironment: getValue('export-pipeline-environment') === 'true'
  }
}
