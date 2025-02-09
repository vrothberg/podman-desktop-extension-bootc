/**********************************************************************
 * Copyright (C) 2024 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import type { ContainerCreateOptions } from '@podman-desktop/api';
import * as extensionApi from '@podman-desktop/api';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import * as containerUtils from './container-utils';
import { bootcImageBuilderContainerName, bootcImageBuilderName } from './constants';
import type { BootcBuildInfo } from '/@shared/src/models/bootc';
import type { History } from './history';
import * as machineUtils from './machine-utils';

const telemetryLogger = extensionApi.env.createTelemetryLogger();

export async function buildDiskImage(build: BootcBuildInfo, history: History): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const telemetryData: Record<string, any> = {};
  let errorMessage: string;

  const requiredFields = [
    { field: 'name', message: 'Bootc image name is required.' },
    { field: 'tag', message: 'Bootc image tag is required.' },
    { field: 'type', message: 'Bootc image type is required.' },
    { field: 'engineId', message: 'Bootc image engineId is required.' },
    { field: 'folder', message: 'Bootc image folder is required.' },
    { field: 'arch', message: 'Bootc image architecture is required.' },
  ];

  // VALIDATION CHECKS
  for (const { field, message } of requiredFields) {
    if (!build[field]) {
      await extensionApi.window.showErrorMessage(message);
      throw new Error(message);
    }
  }

  const isRootful = await machineUtils.isPodmanMachineRootful();
  if (!isRootful) {
    const errorMessage =
      'The podman machine is not set as rootful. Please recreate the podman machine with rootful privileges set and try again.';
    await extensionApi.window.showErrorMessage(errorMessage);
    throw new Error('The podman machine is not set as rootful.');
  }

  let imageName = ''; // Initialize imageName as an empty string

  // Check build.type and assign imageName accordingly
  if (build.type === 'qcow2') {
    imageName = 'qcow2/disk.qcow2';
  } else if (build.type === 'ami') {
    imageName = 'image/disk.raw';
  } else if (build.type === 'raw') {
    imageName = 'image/disk.raw';
  } else if (build.type === 'iso') {
    imageName = 'bootiso/disk.iso';
  } else {
    // If build.type is not one of the expected values, show an error and return
    const errorMessage = 'Invalid image format selected.';
    await extensionApi.window.showErrorMessage(errorMessage);
    throw new Error(errorMessage);
  }

  const imagePath = resolve(build.folder, imageName);

  if (
    fs.existsSync(imagePath) &&
    (await extensionApi.window.showWarningMessage('File already exists, do you want to overwrite?', 'Yes', 'No')) ===
      'No'
  ) {
    return;
  }

  // Add the 'history' information before we start the build
  // this will be improved in the future to add more information
  build.status = 'creating';
  await history.addOrUpdateBuildInfo(build);

  // After resolving all the information, adding it to the history, finally telemetry the data.
  telemetryData.build = build;
  telemetryLogger.logUsage('buildDiskImage', telemetryData);

  // "Returning" withProgress allows PD to handle the task in the background with building.
  return extensionApi.window.withProgress(
    { location: extensionApi.ProgressLocation.TASK_WIDGET, title: 'Building disk image ' + build.name },
    async progress => {
      const buildContainerName = build.name.split('/').pop() + bootcImageBuilderContainerName;
      let successful: boolean = false;
      let logData: string = 'Build Image Log --------\n';
      logData += 'Image:  ' + build.name + '\n';
      logData += 'Type:   ' + build.type + '\n';
      logData += 'Folder: ' + build.folder + '\n';
      logData += '----------\n';

      // Create log folder
      if (!fs.existsSync(build.folder)) {
        await fs.promises.mkdir(build.folder, { recursive: true });
      }
      const logPath = resolve(build.folder, 'image-build.log');
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }

      // Preliminary Step 0. Create the "bootc-image-builder" container
      // options that we will use to build the image. This will help with debugging
      // as well as making sure we delete the previous build, etc.
      const containerName = await getUnusedName(buildContainerName);
      const buildImageContainer = createBuilderImageOptions(
        containerName,
        `${build.name}:${build.tag}`,
        build.type,
        build.arch,
        build.folder,
        imagePath,
      );
      logData += JSON.stringify(buildImageContainer, undefined, 2);
      logData += '\n----------\n';
      try {
        await fs.promises.writeFile(logPath, logData);
      } catch (e) {
        console.debug('Could not write bootc build log: ', e);
      }

      if (!buildImageContainer) {
        await extensionApi.window.showErrorMessage('Error creating container options.');
        return;
      }
      try {
        // Step 1. Pull bootcImageBuilder
        // Pull the bootcImageBuilder since that
        // is what is being used to build images within BootC
        // Do progress report here so it doesn't look like it's stuck
        // since we are going to pull an image
        progress.report({ increment: 4 });
        if (buildImageContainer.Image) {
          await containerUtils.pullImage(buildImageContainer.Image);
        } else {
          throw new Error('No image to pull');
        }

        // Step 2. Check if there are any previous builds and remove them
        progress.report({ increment: 5 });
        if (buildImageContainer.name) {
          await containerUtils.removeContainerIfExists(build.engineId, buildImageContainer.name);
        } else {
          throw new Error('No container name to remove');
        }

        // Step 3. Create and start the container for the actual build
        progress.report({ increment: 6 });
        build.status = 'running';
        await history.addOrUpdateBuildInfo(build);
        const containerId = await containerUtils.createAndStartContainer(build.engineId, buildImageContainer);

        // Update the history with the container id that was used to build the image
        build.buildContainerId = containerId;
        await history.addOrUpdateBuildInfo(build);

        // Step 3.1 Since we have started the container, we can now go get the logs
        await logContainer(build.engineId, containerId, progress, data => async () => {
          try {
            await fs.promises.appendFile(logPath, data);
          } catch (e) {
            console.debug('Could not write bootc build log: ', e);
          }
        });

        // Step 4. Wait for the container to exit
        // This function will ensure it exits with a zero exit code
        // if it does not, it will error out.
        progress.report({ increment: 7 });

        try {
          await containerUtils.waitForContainerToExit(containerId);
        } catch (error) {
          // If we error out, BUT the container does not exist in the history, we will silently error
          // as it's possible that the container was removed by the user during the build cycle / deleted from history.

          // Check if history has an entry with a containerId
          const historyExists = history.getHistory().some(info => info.buildContainerId === containerId);
          if (!historyExists) {
            console.error(
              `Container ${build.buildContainerId} for build ${build.name}:${build.arch} has errored out, but there is no container history. This is likely due to the container being removed intentionally during the build cycle. Ignore this. Error: ${error}`,
            );
            return;
          } else {
            throw error;
          }
        }

        // If we get here, the container has exited with a zero exit code
        // it's successful as well so we will write the log file
        successful = true;
        telemetryData.success = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: unknown) {
        errorMessage = (error as Error).message;
        console.error(error);
        telemetryData.error = error;
      } finally {
        // ###########
        // # CLEANUP #
        // ###########
        // Regardless what happens, we will need to clean up what we started (if anything)
        // which could be containers, volumes, images, etc.
        if (buildImageContainer.name) {
          await containerUtils.removeContainerAndVolumes(build.engineId, buildImageContainer.name);
        }
      }

      // Mark the task as completed
      progress.report({ increment: -1 });
      telemetryLogger.logUsage('buildDiskImage', telemetryData);

      if (successful) {
        try {
          // Update the image build status to success
          build.status = 'success';
          await history.addOrUpdateBuildInfo(build);
        } catch (e) {
          // If for any reason there is an error.. (example, unable to write to history file)
          // we do not want to stop the notification to the user, so
          // just output this to console and continue.
          console.error('Error updating image build status to success', e);
        }

        // Notify the user that the image has been built successfully
        await extensionApi.window.showInformationMessage(
          `Success! Your Bootable OS Container has been succesfully created to ${imagePath}`,
          'OK',
        );
      } else {
        try {
          // Update the image build status to error
          build.status = 'error';
          await history.addOrUpdateBuildInfo(build);
        } catch (e) {
          // Same as above, do not want to block other parts of the build
          // so just output to console.
          console.error(`Error updating image build ${build.name}:${build.tag} status to error: ${e}`);
        }
        if (!errorMessage.endsWith('.')) {
          errorMessage += '.';
        }

        // Notify on an error
        await extensionApi.window.showErrorMessage(
          `There was an error building the image: ${errorMessage} Check logs at ${logPath}`,
          'OK',
        );

        // Make sure we still throw an error even after displaying an error message.
        throw new Error(errorMessage);
      }
    },
  );
}

async function logContainer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  engineId: any,
  containerId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  progress: any,
  callback: (data: string) => void,
): Promise<void> {
  await extensionApi.containerEngine.logsContainer(engineId, containerId, (_name: string, data: string) => {
    if (data) {
      callback(data);
      // look for specific output to mark incremental progress
      if (data.includes('org.osbuild.rpm')) {
        progress.report({ increment: 8 });
      } else if (data.includes('org.osbuild.selinux')) {
        progress.report({ increment: 25 });
      } else if (data.includes('org.osbuild.ostree.config')) {
        progress.report({ increment: 48 });
      } else if (data.includes('org.osbuild.qemu')) {
        progress.report({ increment: 59 });
      } else if (data.includes('Build complete!')) {
        progress.report({ increment: 98 });
      }
    }
  });
}

// find an unused container name
export async function getUnusedName(name: string): Promise<string> {
  let containers: string[] = [];
  try {
    // get a list of all existing container names, which may start with /
    containers = (await extensionApi.containerEngine.listContainers())
      .map(c => c.Names)
      .reduce((a, val) => [...a, ...val], [])
      .map(n => (n.charAt(0) === '/' ? n.substring(1) : n));
  } catch (e) {
    console.warn('Could not get existing container names');
    console.warn(e);
  }

  let unusedName = name;
  let count = 2;
  while (containers.includes(unusedName)) {
    unusedName = name + '-' + count++;
  }
  return unusedName;
}

// Create builder options for the "bootc-image-builder" container
export function createBuilderImageOptions(
  name: string,
  image: string,
  type: string,
  arch: string,
  folder: string,
  imagePath: string,
): ContainerCreateOptions {
  // Create the image options for the "bootc-image-builder" container
  const options: ContainerCreateOptions = {
    name: name,
    Image: bootcImageBuilderName,
    Tty: true,
    HostConfig: {
      Privileged: true,
      SecurityOpt: ['label=type:unconfined_t'],
      Binds: [folder + ':/output/', '/var/lib/containers/storage:/var/lib/containers/storage'],
    },

    // Add the appropriate labels for it to appear correctly in the Podman Desktop UI.
    Labels: {
      'bootc.image.builder': 'true',
      'bootc.build.image.location': imagePath,
      'bootc.build.type': type,
    },
    Cmd: [image, '--type', type, '--target-arch', arch, '--output', '/output/', '--local'],
  };

  return options;
}
