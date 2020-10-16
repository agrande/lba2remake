import * as React from 'react';
import * as THREE from 'three';
import {clone} from 'lodash';

import Renderer from '../renderer';
import {createGame} from '../game/index';
import {mainGameLoop} from '../game/loop';
import { SceneManager } from '../game/scenes';
import {createControls} from '../controls/index';

import {fullscreen} from './styles/index';

import FrameListener from './utils/FrameListener';
import {sBind} from '../utils';
import {TickerProps } from './utils/Ticker';
import {updateLabels} from './editor/labels';
import { setFog } from './editor/fog';
import { pure } from '../utils/decorators';
import { loadPoint } from '../game/points';
import { loadActor, createNewActorProps, initDynamicNewActor } from '../game/actors';
import GUI from './GUI';
import DebugData from './editor/DebugData';
import { getParams } from '../params';
import UIState, { initUIState } from './UIState';

interface GameProps extends TickerProps {
    sharedState?: any;
    stateHandler?: any;
}

export default class Game extends FrameListener<GameProps, UIState> {
    readonly canvas: HTMLCanvasElement;
    readonly clock: THREE.Clock;
    readonly game: any;
    readonly renderer: any;
    readonly sceneManager: any;
    readonly preloadPromise: Promise<void>;
    controls?: [any];
    wrapperElem: HTMLDivElement;

    constructor(props) {
        super(props);

        this.onWrapperElem = this.onWrapperElem.bind(this);
        this.frame = this.frame.bind(this);
        this.onSceneManagerReady = this.onSceneManagerReady.bind(this);
        this.onGameReady = this.onGameReady.bind(this);
        this.setUiState = sBind(this.setUiState, this);
        this.getUiState = sBind(this.getUiState, this);
        this.showMenu = this.showMenu.bind(this);
        this.hideMenu = this.hideMenu.bind(this);
        this.pick = this.pick.bind(this);

        this.clock = new THREE.Clock(false);
        this.game = createGame(
            this.clock,
            this.setUiState,
            this.getUiState,
        );

        this.canvas = document.createElement('canvas');
        this.renderer = new Renderer(this.canvas, 'game');
        this.sceneManager = new SceneManager(
            this.game,
            this.renderer,
            this.hideMenu.bind(this)
        );

        this.state = {
            ...initUIState(this.game),
        };

        this.preloadPromise = this.preload(this.game);
    }

    async preload(game) {
        await game.registerResources();
        await game.preload();
        this.onGameReady();
    }

    setUiState(state, callback) {
        this.setState(state, callback);
    }

    @pure()
    getUiState() {
        return this.state;
    }

    async onWrapperElem(wrapperElem) {
        if (!this.wrapperElem && wrapperElem) {
            this.renderer.threeRenderer.setAnimationLoop(() => {
                this.props.ticker.frame();
            });
            this.onSceneManagerReady(this.sceneManager);
            this.controls = createControls(
                this.game,
                wrapperElem,
                this.sceneManager
            );
            this.wrapperElem = wrapperElem;
            this.wrapperElem.querySelector('.canvasWrapper').appendChild(this.canvas);
        }
    }

    async onSceneManagerReady(sceneManager) {
        if (getParams().scene >= 0) {
            await this.preloadPromise;
            sceneManager.hideMenuAndGoto(getParams().scene);
        }
    }

    checkSceneChange() {
        const sceneParam = getParams().scene;
        const scene = this.sceneManager.getScene();
        if (scene && sceneParam !== -1 && scene.index !== sceneParam) {
            this.sceneManager.hideMenuAndGoto(sceneParam);
        }
    }

    onGameReady() {
        this.game.loaded('game');
        this.clock.start();
        if (getParams().scene === -1) {
            this.showMenu();
        }
    }

    showMenu(inGameMenu = false) {
        this.game.pause();
        const audio = this.game.getAudioManager();
        audio.playMusicTheme();
        this.setState({showMenu: true, inGameMenu});
    }

    hideMenu(wasPaused = false) {
        const audio = this.game.getAudioManager();
        audio.stopMusicTheme();
        if (!wasPaused)
            this.game.resume();
        this.setState({showMenu: false, inGameMenu: false});
        this.canvas.focus();
    }

    async pick(event) {
        const scene = this.sceneManager.getScene();
        if (getParams().editor && scene && this.canvas) {
            const rect = this.canvas.getBoundingClientRect();
            const mouse = new THREE.Vector2();
            mouse.x = ((event.clientX - rect.left) / (rect.width - rect.left)) * 2 - 1;
            mouse.y = -((event.clientY - rect.top) / (rect.bottom - rect.top)) * 2 + 1;

            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(mouse, scene.camera.threeCamera);

            const { sharedState } = this.props;
            if (sharedState && sharedState.objectToAdd) {
                return this.addNewObject(sharedState.objectToAdd, raycaster);
            }

            const tgt = new THREE.Vector3();

            const foundActor = scene.actors.find((actor) => {
                if (actor.threeObject.visible && actor.model) {
                    const bb = actor.model.boundingBox.clone();
                    bb.applyMatrix4(actor.threeObject.matrixWorld);
                    return raycaster.ray.intersectBox(bb, tgt);
                }
                return false;
            });
            if (foundActor) {
                DebugData.selection = {type: 'actor', index: foundActor.index};
                event.stopPropagation();
                return;
            }

            const foundPoint = scene.points.find((point) => {
                if (point.threeObject.visible) {
                    const bb = point.boundingBox.clone();
                    bb.applyMatrix4(point.threeObject.matrixWorld);
                    return raycaster.ray.intersectBox(bb, tgt);
                }
                return false;
            });
            if (foundPoint) {
                DebugData.selection = {type: 'point', index: foundPoint.index};
                event.stopPropagation();
                return;
            }

            const foundZone = scene.zones.find((zone) => {
                if (zone.threeObject.visible) {
                    const bb = zone.boundingBox.clone();
                    bb.applyMatrix4(zone.threeObject.matrixWorld);
                    return raycaster.ray.intersectBox(bb, tgt);
                }
                return false;
            });
            if (foundZone) {
                DebugData.selection = {type: 'zone', index: foundZone.index};
                event.stopPropagation();
            }
        }
    }

    async addNewObject(objectToAdd, raycaster) {
        const scene = this.sceneManager.getScene();
        const [result] = raycaster.intersectObject(scene.scenery.threeObject, true);
        if (result) {
            let obj = null;
            const position = result.point.clone();
            if (scene.isIsland) {
                position.sub(scene.sceneNode.position);
            }
            if (objectToAdd.type === 'point') {
                obj = loadPoint({
                    sceneIndex: scene.index,
                    index: scene.points.length,
                    pos: position.toArray()
                });
            }
            if (objectToAdd.type === 'actor') {
                const actor = await loadActor(
                    this.game,
                    scene.is3DCam,
                    scene.envInfo,
                    scene.data.ambience,
                    createNewActorProps(scene, position, objectToAdd.details),
                    !scene.isActive,
                    {}
                );
                initDynamicNewActor(this.game, scene, actor);
                obj = actor;
            }
            if (obj) {
                obj.threeObject.visible = true;
                scene[`${objectToAdd.type}s`].push(obj);
                scene.sceneNode.add(obj.threeObject);
                this.props.stateHandler.setAddingObject(null);
            }
        }
    }

    frame() {
        this.checkSceneChange();
        this.checkResize();
        const scene = this.sceneManager.getScene();
        mainGameLoop(
            this.game,
            this.clock,
            this.renderer,
            scene,
            this.controls
        );
        if (getParams().editor) {
            DebugData.scope = {
                params: getParams(),
                game: this.game,
                clock: this.clock,
                renderer: this.renderer,
                scene,
                sceneManager: this.sceneManager,
                hero: scene && scene.actors[0],
                controls: this.controls,
                uiState: this.state
            };
            DebugData.sceneManager = this.sceneManager;
            updateLabels(scene, this.props.sharedState.labels);
            setFog(scene, this.props.sharedState.fog);
        }
    }

    checkResize() {
        if (this.wrapperElem) {
            const { clientWidth, clientHeight } = this.wrapperElem;
            const rWidth = `${clientWidth}px`;
            const rHeight = `${clientHeight}px`;
            const style = this.canvas.style;
            if (rWidth !== style.width || rHeight !== style.height) {
                this.renderer.resize(clientWidth, clientHeight);
                if (this.state.video) {
                    this.setState({
                        video: clone(this.state.video)
                    }); // Force video rerender
                }
            }
        }
    }

    render() {
        return <div ref={this.onWrapperElem} style={fullscreen} tabIndex={0}>
            <div className="canvasWrapper" style={fullscreen} onClick={this.pick}/>
            {this.renderGUI()}
        </div>;
    }

    renderGUI() {
        return <GUI
            game={this.game}
            renderer={this.renderer}
            sceneManager={this.sceneManager}
            showMenu={this.showMenu}
            hideMenu={this.hideMenu}
            setUiState={this.setUiState}
            uiState={this.state}
            sharedState={this.props.sharedState}
            stateHandler={this.props.stateHandler}
        />;
    }
}