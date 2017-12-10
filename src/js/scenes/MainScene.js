'use strict'

// libs
import * as THREE from 'three'
import { map } from '../../utils/math'
import moment from 'moment'
import EventEmitter from 'eventemitter3'

// Global config
import Config from '../Config'

// Audio
import Audio from '../audio/audio'

// API
import API from '../api/btc'

// Custom Materials
import BlockMaterial from '../materials/BlockMaterial'

const dat = require('dat-gui')

const DayBuilderWorker = require('worker-loader!../workers/dayBuilder.js')
const TreeBuilderWorker = require('worker-loader!../workers/treeBuilder.js')
const TWEEN = require('@tweenjs/tween.js')

export default class MainScene extends EventEmitter {
  constructor ({
      params = {}
    } = {}
  ) {
    super()
    this.params = params

    this.cubeCamera = null

    this.api = new API()

    this.stage = params.stage // reference to the stage

    this.initProperties() // class properties
    this.initState()
    this.addInteraction()

    this.audio = new Audio(this.stage.camera)

    this.audio.init()

    this.addEvents()
    this.setupMaterials()
    this.initGui()

    this.initReflection()

    this.dayBuilderWorker = new DayBuilderWorker()
    this.dayBuilderWorker.addEventListener('message', this.addBlocksToStage.bind(this), false)
  }

  setDate (date, focusOnBlock = false) {
    if (this.state.currentDate === null) {
      this.state.currentDate = date
    }
    let currentDate = moment(this.state.currentDate)

    let inputDate = moment(date)

    let dayIndex = currentDate.diff(inputDate, 'days')

      // move camera
    let newOffset = this.dayZOffset * dayIndex
    this.stage.targetCameraLookAt.z = newOffset
    this.stage.targetCameraPos.z = newOffset + this.stage.defaultCameraPos.z

    this.state.closestDayIndex = dayIndex

    this.loadBlocks(inputDate.valueOf(), dayIndex, focusOnBlock, dayIndex)
  }

  initReflection () {
    let CubeCamera = function (position) {
      let camera = new THREE.CubeCamera(100.0, 5000, 2048)
      camera.position.set(position.x, position.y, position.z)
      camera.renderTarget.texture.minFilter = THREE.LinearMipMapLinearFilter
      this.camera = camera
      this.textureCube = camera.renderTarget.texture

      this.update = function (renderer, scene) {
        camera.update(renderer, scene)
      }

      this.updatePosition = function (position) {
        camera.position.set(position.x, position.y, position.z)
      }
    }
    this.cubeCamera = new CubeCamera(new THREE.Vector3(0.0, 0.0, 0.0))
  }

  initGui () {
    if (!Config.showGUI) {
      return
    }

    this.gui = new dat.GUI({ width: 300 })
    this.gui.open()

    let param = {
      blockMetalness: 0.9,
      blockRoughness: 0.2,
      blockColor: this.blockMaterial.color.getHex(),
      blockEmissive: this.blockMaterial.emissive.getHex(),
      blockLightIntesity: 5.0,
      //
      merkleMetalness: 0.9,
      merkleRoughness: 0.1,
      merkleColor: this.merkleMaterial.color.getHex(),
      merkleEmissive: this.merkleMaterial.emissive.getHex(),
      //
      backgroundColor: Config.scene.bgColor,
      vignetteAmount: 1.2,
      cameraFOV: Config.camera.fov
    }

    /**
     * Create a GUI for a material
     */
    const createGuiForMaterial = (mat, title) => {
      let f = this.gui.addFolder(title)
      f.add(mat, 'metalness', 0.0, 1.0).step(0.01)
      f.add(mat, 'roughness', 0.0, 1.0).step(0.01)
      f.add(mat, 'bumpScale', 0.0, 1.0).step(0.01)
      f.add(mat, 'opacity', 0.0, 1.0).step(0.01)
      if (mat.reflectivity) f.add(mat, 'reflectivity', 0.0, 1.0).step(0.01)
      f.addColor({color: mat.color.getHex()}, 'color').onChange(val => mat.color.setHex(val))
      f.addColor({emissive: mat.emissive.getHex()}, 'emissive').onChange(val => mat.emissive.setHex(val))
    }

     /**
     * Gui for Material
     */
    createGuiForMaterial(this.centralBlockMaterial, 'Central Block Material')
    createGuiForMaterial(this.blockMaterial, 'Block Material')
    createGuiForMaterial(this.merkleMaterial, 'Merkle Block Material')

    /*
      Light GUI
    */
    let lightFolder = this.gui.addFolder('Lighting')
    lightFolder.add(this.stage.pointLight, 'intensity', 0.0, 10.0).step(0.01)

    /**
     * Scene
     */
    let sceneFolder = this.gui.addFolder('Scene')
    sceneFolder.addColor(param, 'backgroundColor').onChange(function (val) {
      this.stage.scene.background = new THREE.Color(val)
      this.stage.scene.fog.color = new THREE.Color(val)
    }.bind(this))

    sceneFolder.add(param, 'vignetteAmount', 1.0, 2.0).step(0.01).onChange(function (val) {
      this.stage.VignettePass.uniforms.darkness.value = val
    }.bind(this))

    sceneFolder.add(param, 'cameraFOV', 45.0, 100.0).step(0.01).onChange(function (val) {
      this.stage.camera.fov = val
      this.stage.camera.updateProjectionMatrix()
    }.bind(this))
  }

  initState (blocks, currentDate) {
    this.state = {
      frameCount: 0,
      currentDate: null,
      dayGroups: [],
      loadDayRequested: false,
      currentBlock: null,
      currentBlockObject: null,
      view: 'day', // can be 'day' or 'block'
      dayData: [], // all blocks grouped by day
      currentDay: null, // which day is the camera closest to
      blocksToAnimate: [],
      closestDayIndex: 0,
      minCameraZPos: 0,
      maxCameraZPos: 0
    }
  }

  /**
   * Load in blocks for one day
   */
  loadBlocks (date, dayIndex = 0, focusOnBlock = false) {
    this.state.loadDayRequested = true

    // prune days too far away from viewer
    for (const key in this.state.dayData) {
      if (this.state.dayData.hasOwnProperty(key)) {
        if (Math.abs(key - this.state.closestDayIndex) > 5) {
          delete this.state.dayData[key]
          this.stage.scene.remove(this.state.dayGroups[key])
        }
      }
    }

    if (window.Worker) {
      const fromDate = moment(date).startOf('day').toDate()
      const toDate = moment(date).endOf('day').toDate()
      const timeStamp = fromDate.valueOf()

      this.api.getBlocksSince(fromDate, toDate).then((blocks) => {
        const day = {
          blocks: blocks,
          timeStamp: timeStamp
        }

        this.dayBuilderWorker.postMessage({
          cmd: 'build',
          blocks: day.blocks,
          timeStamp: day.timeStamp,
          dayIndex: dayIndex,
          focusOnBlock: focusOnBlock
        })
      })
    } else {
      console.log('Webworkers not supported. Sad')
    }
  }

  addBlocksToStage (e) {
    if (typeof e.data.sizes === 'undefined') {
      return
    }

    try {
      let workerData = e.data
      let sizes = workerData.sizes
      let blockCount = workerData.blockCount
      let timeStamp = workerData.timeStamp
      let dayIndex = workerData.dayIndex
      let blocks = workerData.blocks
      let focusOnBlock = workerData.focusOnBlock

      this.state.dayData[dayIndex] = {
        blocks: blocks,
        timeStamp: timeStamp
      }

      let group = new THREE.Group()
      this.state.dayGroups[dayIndex] = group
      this.stage.scene.add(group)
      this.blocksToAnimate = []

      for (let index = 0; index < sizes.length; index++) {
        const size = sizes[index]
        const block = blocks[index]

        if (
          size.x === 0 ||
          size.y === 0 ||
          size.z === 0
        ) {
          continue
        }

        let blockMesh = new THREE.Mesh(this.boxGeometry, this.blockMaterial)

        blockMesh.renderOrder = ((index * -dayIndex) + 1000000)

        // blockMesh.material.opacity = 0.0
        blockMesh.visible = false
        blockMesh.scale.set(size.x, size.y, size.z)

        // align all front faces
        blockMesh.translateZ(-(size.z / 2))

        let rotation = ((25 * Math.PI) / blockCount) * index
        blockMesh.rotation.z = rotation
        blockMesh.translateY(700 + (index))
        blockMesh.rotation.z += Math.PI / 2
        blockMesh.translateZ((index * 18))
        blockMesh.blockchainData = block

        let edgeGeo = new THREE.EdgesGeometry(blockMesh.geometry)
        let wireframe = new THREE.LineSegments(edgeGeo, this.blockMaterialOutline)
        blockMesh.add(wireframe)

        group.add(blockMesh)
      }

      let zPos = this.dayZOffset * dayIndex
      group.translateZ(zPos)
      this.state.dayData[dayIndex].zPos = zPos
      this.state.loadDayRequested = false

      let that = this
      Object.keys(this.state.dayGroups).forEach(function (key) {
        let group = that.state.dayGroups[key]
        that.stage.scene.remove(group)
      })

      Object.keys(this.state.dayGroups).reverse().forEach(function (key) {
        let group = that.state.dayGroups[key]
        that.stage.scene.add(group)
      })

      if (this.treeGroup) {
        that.stage.scene.remove(this.treeGroup)
        that.stage.scene.add(this.treeGroup)
      }

      if (focusOnBlock) {
        for (let index = 0; index < this.state.dayGroups[dayIndex].children.length; index++) {
          const mesh = this.state.dayGroups[dayIndex].children[index]
          if (mesh.blockchainData.hash === this.state.currentHash) {
            this.focusOnBlock(mesh)
            break
          }
        }
      }
    } catch (error) {
      console.log(error)
    }
  }

  initProperties () {
    this.boxGeometry = new THREE.BoxBufferGeometry(1.0, 1.0, 1.0) // block geo instance
    this.dayZOffset = -3500 // offset for each day on z-axis
    this.treeGroup = null
    this.blockLoadZThreshold = 10000 // how far away from the last block until we load in another?
    this.crystalOpacity = 0.5
    this.pointLightTarget = new THREE.Vector3(0.0, 0.0, 0.0)
    this.cameraBlockFocusDistance = 300
  }

  addInteraction () {
    this.raycaster = new THREE.Raycaster()
    this.intersected = null
  }

  addEvents () {
    document.addEventListener('preUpdate', this.onUpdate.bind(this), false)
    document.addEventListener('cameraMove', this.onCameraMove.bind(this), false)

    this.selectBlock = new Event('selectBlock')

    this.dayChangedEvent = document.createEvent('CustomEvent')

    // mousewheel controls camera z position
    document.addEventListener('mousewheel', this.onDocumentMouseWheel.bind(this), false)

    document.addEventListener('mousedown', this.onDocumentMouseDown.bind(this), false)
    document.addEventListener('keydown', this.onKeyDown.bind(this), false)

    if (window.Worker) {
      this.treeBuilderWorker = new TreeBuilderWorker()
      this.treeBuilderWorker.addEventListener('message', this.addTreeToStage.bind(this), false)
    }
  }

  addTreeToStage (e) {
    if (typeof e.data.vertices === 'undefined') {
      return
    }

    let boxCenter = e.data.boxCenter
    let endNodes = e.data.endNodes
    let vertices = e.data.vertices

    this.removeTrees()

    this.treeGroup = new THREE.Group()
    this.stage.scene.add(this.treeGroup)

    let blockObjectPosition = this.state.currentBlockObject.getWorldPosition().clone()
    let rotation = this.state.currentBlockObject.getWorldRotation().clone()

    let treeGeo = new THREE.BufferGeometry()
    treeGeo.addAttribute('position', new THREE.BufferAttribute(vertices, 3))

    treeGeo.computeVertexNormals()
    treeGeo.computeFaceNormals()

    let mesh = new THREE.Mesh(treeGeo, this.merkleMaterial)

    mesh.translateX(-boxCenter.x)
    mesh.translateY(-boxCenter.y)
    mesh.translateZ(-boxCenter.z)

    mesh.renderOrder = 10000000
    mesh.onBeforeRender = (renderer) => {
      renderer.clearDepth()
    }

    this.treeGroup.add(mesh)

    this.treeGroup.rotation.set(rotation.x, rotation.y, rotation.z)
    this.treeGroup.position.set(blockObjectPosition.x, blockObjectPosition.y, blockObjectPosition.z)

    let seen = []
    let reducedArray = []

    for (let index = 0; index < endNodes.length; index++) {
      const nodePos = endNodes[index]
      let position = {
        x: Math.ceil(nodePos.x / 10) * 10,
        y: Math.ceil(nodePos.y / 10) * 10,
        z: Math.ceil(nodePos.z / 10) * 10
      }

      let key = JSON.stringify(position)

      if (seen.indexOf(key) === -1) {
        seen.push(key)
        nodePos.y = Math.abs(nodePos.y) * 1.2
        reducedArray.push(nodePos)
      }
    }

    this.audio.generateMerkleSound(reducedArray, blockObjectPosition)
  }

  onKeyDown (event) {
    let isEscape = false
    if ('key' in event) {
      isEscape = (event.key === 'Escape' || event.key === 'Esc')
    } else {
      isEscape = (event.keyCode === 27)
    }
    if (isEscape) {
      this.resetDayView()
    }
  }

  resetDayView () {
    this.removeTrees()

    this.animateBlockOut(this.state.currentBlockObject).then(() => {
      this.state.view = 'day'
      this.isAnimating = false
    })
  }

  removeTrees () {
    if (typeof this.treeGroup !== 'undefined') {
      this.stage.scene.remove(this.treeGroup)
      this.treeGroup = null
    }
    this.audio.unloadSound()
  }

  onDocumentMouseDown (event) {
    event.preventDefault()

    if (event.target.className !== 'main') {
      return
    }

    if (this.isAnimating) {
      return
    }

    this.raycaster.setFromCamera({x: this.stage.targetMousePos.x, y: this.stage.targetMousePos.y}, this.stage.camera)

    for (const key in this.state.dayGroups) {
      if (this.state.dayGroups.hasOwnProperty(key)) {
        const group = this.state.dayGroups[key]
        var intersects = this.raycaster.intersectObjects(group.children)
        if (intersects.length > 0) {
          if (intersects[0].object === this.state.currentBlockObject) {
            this.resetDayView()
            break
          }

          this.removeTrees()
          this.isAnimating = true
          let blockObject = intersects[0].object
          this.focusOnBlock(blockObject)
          break
        }
      }
    }
  }

  refreshCubeMap (blockObject) {
    if (this.cubeCamera) {
      this.blockMaterial.envMap = this.bgMap
      this.cubeCamera.updatePosition(new THREE.Vector3(0.0, 0.0, blockObject.getWorldPosition().z))
      this.cubeCamera.update(this.stage.renderer, this.stage.scene)

      this.centralBlockMaterial.envMap = this.cubeCamera.textureCube

      blockObject.material = this.centralBlockMaterial

      this.merkleMaterial.envMap = this.cubeCamera.textureCube

      this.blockMaterial.envMap = this.cubeCamera.textureCube
      this.blockMaterial.color.setHex(0xffffff)
    }
  }

  animateBlock (blockObject, fromPos, fromQuaternion, toPos, toQuaternion, duration) {
    return new Promise((resolve, reject) => {
      let moveQuaternion = new THREE.Quaternion()
      blockObject.quaternion.set(moveQuaternion)

      this.easing = TWEEN.Easing.Quartic.InOut

      let tweenVars = {
        blockPosX: fromPos.x,
        blockPosY: fromPos.y,
        time: 0
      }

      new TWEEN.Tween(tweenVars)
        .to(
        {
          blockPosX: toPos.x,
          blockPosY: toPos.y,
          time: 1
        },
          duration
        )
        .onUpdate(function () {
          blockObject.position.x = tweenVars.blockPosX
          blockObject.position.y = tweenVars.blockPosY

          // slerp to target rotation
          THREE.Quaternion.slerp(fromQuaternion, toQuaternion, moveQuaternion, tweenVars.time)
          blockObject.quaternion.set(moveQuaternion.x, moveQuaternion.y, moveQuaternion.z, moveQuaternion.w)
        })
        .easing(this.easing)
        .onComplete(function () {
          resolve()
        })
        .start()
    })
  }

  animateBlockOut (blockObject) {
    return new Promise((resolve, reject) => {
      if (blockObject) {
        let fromPos = blockObject.position.clone()
        let toPos = blockObject.initialPosition.clone()

        let targetRotation = blockObject.initialRotation.clone()
        let fromQuaternion = new THREE.Quaternion().copy(blockObject.quaternion)
        let toQuaternion = new THREE.Quaternion().setFromEuler(targetRotation)

        this.animateBlock(
          blockObject,
          fromPos,
          fromQuaternion,
          toPos,
          toQuaternion,
          500
        ).then(() => {
          resolve()
        })
      } else {
        resolve()
      }
    })
  }

  animateBlockIn (blockObject) {
    return new Promise((resolve, reject) => {
      this.state.currentBlockObject = blockObject

      let blockPos = blockObject.position.clone()

      let targetRotation = new THREE.Euler(0.0, 0.0, 0.0)
      let fromQuaternion = new THREE.Quaternion().copy(blockObject.quaternion)
      let toQuaternion = new THREE.Quaternion().setFromEuler(targetRotation)

      blockObject.initialPosition = blockObject.position.clone()
      blockObject.initialRotation = blockObject.rotation.clone()

      // focus camera on block
      let blockWorldPos = blockObject.getWorldPosition()

      this.stage.targetCameraLookAt.z = blockWorldPos.z
      this.stage.targetCameraPos.z = blockWorldPos.z + this.cameraBlockFocusDistance

      this.animateBlock(
        blockObject,
        blockPos,
        fromQuaternion,
        this.stage.targetCameraLookAt,
        toQuaternion,
        1000,
        true
      ).then(() => {
        resolve()
      })
    })
  }

  buildTree (blockObject) {
    let block = blockObject.blockchainData
    this.state.currentBlock = block
    this.removeTrees()
    this.treeBuilderWorker.postMessage(
      {
        cmd: 'build',
        block: block
      }
    )
  }

  setupMaterials () {
    this.cubeMapUrls = [
      'px.png',
      'nx.png',
      'py.png',
      'ny.png',
      'pz.png',
      'nz.png'
    ]

    let bumpMap = new THREE.TextureLoader().load('/static/assets/textures/noise-bump-2.jpg')
    this.bgMap = new THREE.CubeTextureLoader().setPath('/static/assets/textures/').load(this.cubeMapUrls)
    // this.stage.scene.background = this.bgMap

    this.blockMaterial = new BlockMaterial({
      color: 0xaaaaaa,
      emissive: 0x000000,
      metalness: 0.9,
      roughness: 0.2,
      opacity: 0.5,
      transparent: true,
      side: THREE.DoubleSide,
      envMap: this.bgMap,
      bumpMap,
      bumpScale: 0.03
    })

    this.centralBlockMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      emissive: 0x333333,
      metalness: 0.8,
      roughness: 0.2,
      opacity: 0.5,
      transparent: true,
      side: THREE.DoubleSide,
      envMap: this.bgMap,
      bumpMap,
      bumpScale: 0.03
    })

    this.blockMaterialOutline = new THREE.LineBasicMaterial({
      color: 0xcccccc,
      transparent: true,
      opacity: 0.25
    })

    this.blockMaterialHighlight = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      metalness: 0.9,
      roughness: 0.2,
      opacity: 0.8,
      transparent: true,
      side: THREE.DoubleSide
    })

    this.merkleMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x444444,
      flatShading: true,
      metalness: 0.8,
      roughness: 0.3,
      opacity: 0.3,
      /* depthTest: false,
      depthWrite: false, */
      transparent: true,
      side: THREE.DoubleSide,
      envMap: this.bgMap
    })
  }

  checkMouseIntersection () {
    var vector = new THREE.Vector3(this.stage.targetMousePos.x, this.stage.targetMousePos.y, 0.5)
    vector.unproject(this.stage.camera)
    var ray = new THREE.Raycaster(this.stage.camera.position, vector.sub(this.stage.camera.position).normalize())

    for (const dayIndex in this.state.dayGroups) {
      if (this.state.dayGroups.hasOwnProperty(dayIndex)) {
        const group = this.state.dayGroups[dayIndex]
        let intersects = ray.intersectObjects(group.children)
        if (intersects.length > 0) {
          if (
              intersects[0].object !== this.intersected &&
              intersects[0].object !== this.state.currentBlockObject
            ) {
            if (
              this.intersected &&
              this.intersected.material.uuid !== this.centralBlockMaterial.uuid
            ) {
              this.intersected.material = this.blockMaterial
            }

            this.intersected = intersects[0].object

            if (this.intersected.material.uuid !== this.centralBlockMaterial.uuid) {
              this.intersected.material = this.blockMaterialHighlight
            }

            const blockWorldPos = this.intersected.getWorldPosition()

            this.pointLightTarget = blockWorldPos
          }
          break
        } else {
          if (
            this.intersected &&
            this.intersected.material.uuid !== this.centralBlockMaterial.uuid
          ) {
            this.intersected.material = this.blockMaterial
          }
          this.intersected = null
        }
      }
    }
  }

  onCameraMove () {
    // which day are we closest to?
    let closest = Number.MAX_VALUE
    let closestDayIndex = 0

    for (const dayIndex in this.state.dayData) {
      if (this.state.dayData.hasOwnProperty(dayIndex)) {
        const day = this.state.dayData[dayIndex]
        let dist = Math.abs(day.zPos - this.stage.camera.position.z)
        if (dist < closest) {
          closest = dist
          closestDayIndex = parseInt(dayIndex)
        }
      }
    }

    this.state.currentDay = this.state.dayData[closestDayIndex]

    // bubble up event
    if (this.state.closestDayIndex !== closestDayIndex) {
      this.emit(this.dayChangedEvent, this.state.currentDay)
    }

    this.state.closestDayIndex = closestDayIndex

    if (
      this.state.loadDayRequested === false &&
      this.state.currentDay !== undefined
    ) {
      // count 5 either side of current day
      for (let index = -5; index <= 5; index++) {
        let day = moment(this.state.currentDay.timeStamp).subtract(index, 'day').format('YYYY-MM-DD')
        if (typeof this.state.dayData[closestDayIndex + index] === 'undefined') {
          this.loadBlocks(day, (closestDayIndex + index))
          let latestDayIndex = Number.MAX_SAFE_INTEGER
          let earliestDayIndex = 0

          for (const key in this.state.dayData) {
            if (this.state.dayData.hasOwnProperty(key)) {
              const data = this.state.dayData[key]
              if (data.blocks.length > 0) {
                latestDayIndex = Math.min(latestDayIndex, parseInt(key))
                earliestDayIndex = Math.max(earliestDayIndex, parseInt(key))
              }
            }
          }

          if (
            typeof this.state.dayData[latestDayIndex] !== 'undefined' &&
            typeof this.state.dayData[earliestDayIndex] !== 'undefined'
          ) {
            this.state.maxCameraZPos = this.state.dayData[latestDayIndex].zPos + this.stage.defaultCameraPos.z
            this.state.minCameraZPos = this.state.dayData[earliestDayIndex].zPos
          }
          break
        }
      }
    }

    /* this.state.hashRate = this.state.currentDay.hashRate
    this.state.audioFreqCutoff = map(this.state.hashRate, 0.0, 20000000.0, 50.0, 15000) // TODO: set upper bound to max hashrate from blockchain.info

    console.log(this.state.audioFreqCutoff) */

   // this.state.audioFreqCutoff = 20000

    // this.audio.setAmbienceFilterCutoff(this.state.audioFreqCutoff)
  }

  onDocumentMouseWheel (event) {
    if (this.scrollBlocked) {
      return
    }

    event.preventDefault()

    if (Math.abs(event.wheelDeltaY) > 0) {
      this.scrollBlocked = true
      setTimeout(() => {
        this.scrollBlocked = false
      }, 100)
    }

    if (this.stage.targetCameraPos.z < this.state.minCameraZPos) {
      this.stage.targetCameraPos.z = this.state.minCameraZPos
      return
    }

    if (this.stage.targetCameraPos.z > this.state.maxCameraZPos) {
      this.stage.targetCameraPos.z = this.state.maxCameraZPos
      return
    }

    if (event.wheelDeltaY > 0) {
      this.stage.targetCameraPos.z -= this.stage.cameraMoveStep
      this.stage.targetCameraLookAt.z -= this.stage.cameraMoveStep
    } else if (event.wheelDeltaY < 0) {
      this.stage.targetCameraPos.z += this.stage.cameraMoveStep
      this.stage.targetCameraLookAt.z += this.stage.cameraMoveStep
    }
  }

  loadBlock (hash = null) {
    this.api.getBlock(hash).then((block) => {
      let blockDay = moment(block.time * 1000).format('YYYY-MM-DD')
      this.state.currentHash = block.hash
      this.setDate(blockDay, true)
    })
  }

  focusOnBlock (blockObject) {
    blockObject.visible = true
    this.state.view = 'block'
    this.refreshCubeMap(blockObject)
    this.animateBlockOut(this.state.currentBlockObject).then(() => {
      this.animateBlockIn(blockObject).then(() => {
        this.buildTree(blockObject)
        this.isAnimating = false
        this.emit('blockSelected', blockObject.blockchainData)
      })
    })
  }

  animateTree () {
    if (this.state.view === 'block') {
      if (this.treeGroup) {
        this.state.currentBlockObject.rotation.y += 0.001
        this.treeGroup.rotation.y += 0.001
      }
    }
  }

  animateBlockOpacity () {
    for (const dayIndex in this.state.dayGroups) {
      if (this.state.dayGroups.hasOwnProperty(dayIndex)) {
        const dayGroup = this.state.dayGroups[dayIndex]
        for (let meshIndex = 0; meshIndex < dayGroup.children.length; meshIndex++) {
          const mesh = dayGroup.children[meshIndex]
          if (mesh.visible === false) {
            mesh.visible = true
            break
          }
        }
      }
    }
  }

  updateLights () {
    this.stage.pointLight.position.lerp(this.pointLightTarget, 0.5)
  }

  onUpdate () {
    this.state.frameCount++
    TWEEN.update()
    this.updateLights()
    this.checkMouseIntersection()
    this.animateTree()
    this.animateBlockOpacity()
  }
}
