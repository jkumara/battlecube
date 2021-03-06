import Error from './error-code';
import {
  BotDirection, CollisionInfo, GameConfig, ItemType, PlayerWithHighScore, MoveOrder, NextTickInfo, PlaceBombOrder,
  PlayerPosition,
  PlayerSetup,
  PreValidationInfo, HighScoreInfo, GameItem, GameSetup
} from './models';
import {
  coordinateIsInUse, getDirectionsFromBot, getRandom3DCoordinate, isOutOfBounds,
  isSameCoordinate, wait
} from './helpers';
import { getValidatedBotDirections } from './validators';

export class Game {
  socket: any;
  gameConfig: GameConfig;
  playerPositions: PlayerPosition[] = [];
  gameStarted = false;
  edgeLength: number;
  numOfTasksPerTick: number;
  otherItems: GameItem[] = [];

  currentTick = 0;
  subTick = 0;
  lostPlayers: PlayerWithHighScore[] = [];
  gameEnded = false;
  preValidationInfo: PreValidationInfo = {
    players: [],
    collisions: [],
    outOfBoundsPlayers: []
  };
  gameSetupUpdate: GameSetup | null = null;

  cachedDirections: { [ name: string ]: BotDirection[] } = {};

  constructor(gameConfig: GameConfig, socket: any) {
    this.gameConfig = gameConfig;
    this.edgeLength = gameConfig.setup.edgeLength;
    this.numOfTasksPerTick = gameConfig.setup.numOfTasksPerTick;
    this.socket = socket;
  }

  positionPlayers() {
    // Get custom positions only when game is started
    if (this.gameConfig.setup.playerStartPositions && !this.gameStarted) {
      this.playerPositions = this.gameConfig.setup.playerStartPositions;
      return;
    }

    this.playerPositions = this.gameConfig.players.map(({ name }) => {
      let coordinate = getRandom3DCoordinate(this.edgeLength - 1);

      while (coordinateIsInUse(coordinate, this.playerPositions)) {
        coordinate = getRandom3DCoordinate(this.edgeLength - 1);
      }

      return {
        name,
        ...coordinate
      };
    });

  }

  resetPreValidationInfo() {
    this.preValidationInfo = {
      players: [],
      collisions: [],
      outOfBoundsPlayers: []
    };
  }

  getNextTickInfo() {
    return new NextTickInfo({
      players: this.playerPositions,
      items: this.otherItems,
      gameInfo: {
        id: this.socket.id,
        edgeLength: this.edgeLength,
        numOfTasksPerTick: this.numOfTasksPerTick,
        numOfBotsInPlay: this.playerPositions.length,
        currentTick: this.currentTick
      }
    });
  }

  moveBot(player: PlayerSetup, moveOrder: BotDirection) {
    const currentPlayerPosition: any = this.playerPositions.find(p => p.name === player.name);

    const [op, axis] = (<MoveOrder>moveOrder).direction.toLowerCase().split('');
    if (op === '+') {
      currentPlayerPosition[axis] = currentPlayerPosition[axis] + 1;
    } else {
      currentPlayerPosition[axis] = currentPlayerPosition[axis] - 1;
    }

    this.socket.emit('PLAYER_MOVE_ATTEMPT', currentPlayerPosition);

    // push out of bounds player to lostPlayers array
    if (isOutOfBounds(currentPlayerPosition, this.edgeLength)) {
      if (!this.lostPlayers.find(p => p.name === player.name)) this.lostPlayers.push({
        ...player,
        highScore: this.currentTick
      });
      throw 'Player moved out of bounds';
    }
  }

  placeBomb(player: PlayerSetup, bombOrder: BotDirection) {
    const { x, y, z } = <PlaceBombOrder>bombOrder;
    const collision = this.preValidationInfo.collisions.find(collision => isSameCoordinate(collision, <PlaceBombOrder>bombOrder));
    if (collision) {
      collision.hasBomb = true;
    } else {
      if (!coordinateIsInUse(<PlaceBombOrder>bombOrder, this.otherItems)) {
        this.otherItems.push({
          x,
          y,
          z,
          type: <ItemType>'BOMB'
        });
      }
    }

    this.socket.emit('PLAYER_PLACED_BOMB', {
      x,
      y,
      z,
      name: player.name
    });
  }

  noopPlayer(player: PlayerSetup, noopOrder: BotDirection) {
    const { x, y, z } = <PlayerPosition>this.playerPositions.find(p => p.name === player.name);
    this.socket.emit('PLAYER_DID_NOTHING', {
      x,
      y,
      z,
      name: player.name
    });
    // Do nothing.
  }

  applyBotDirections(player: PlayerSetup, directions: BotDirection[]) {
    directions.forEach((direction) => {
      if (direction.task === 'MOVE') {
        this.moveBot(player, direction);
      } else if (direction.task === 'BOMB') {
        this.placeBomb(player, direction);
      } else if (direction.task === 'NOOP') {
        this.noopPlayer(player, direction);
      }
    });
  }

  playerLost(playerSetup: PlayerSetup, cause: any) {
    this.socket.emit('PLAYER_LOST', {
      cause,
      name: playerSetup.name
    });

    if (!this.lostPlayers.find(p => p.name === playerSetup.name)) {
      this.lostPlayers.push({
        ...playerSetup,
        highScore: this.currentTick
      });
    }
  }

  executeDirectionsOfAllBots() {
    const lostPlayerNames = this.lostPlayers.map(p => p.name);
    const activePlayers = this.playerPositions
      .filter(p => !lostPlayerNames.includes(p.name))
      .map(player => <PlayerSetup>this.gameConfig.players.find(p => p.name === player.name));

    for (const playerSetup of activePlayers) {
      try {
        this.applyBotDirections(playerSetup, [this.cachedDirections[playerSetup.name][this.subTick - 1]]);
      } catch (cause) {
        this.playerLost(playerSetup, cause);
      }
    }

    // Check for collisions
    this.playerPositions.forEach((player: PlayerPosition, i: number) => {
      const otherPlayers = this.playerPositions.filter((p, i2) => i2 !== i);
      const bombs = this.otherItems.filter(item => item.type === 'BOMB');
      const hasBomb = coordinateIsInUse(player, bombs);
      if (coordinateIsInUse(player, otherPlayers) || hasBomb) {
        const foundCollisionInfo = this.preValidationInfo.collisions.find(info => isSameCoordinate(info, player));

        if (foundCollisionInfo) {
          if (!foundCollisionInfo.players.find(p => p.name === player.name)) foundCollisionInfo.players.push(player);
        } else {
          const { x, y, z } = player;
          this.preValidationInfo.collisions.push({
            x,
            y,
            z,
            hasBomb,
            players: [player]
          });
        }
      }
    });

    // Filter out collisioned players
    this.preValidationInfo.collisions.forEach((collision) => {
      collision.players.forEach((player) => {
        this.playerPositions = this.playerPositions.filter(p => p.name !== player.name);
      });
    });

    // Filter out connections lost
    this.lostPlayers.forEach((player) => {
      this.playerPositions = this.playerPositions.filter(p => p.name !== player.name);
    });

    // Filter out ones out of bounds
    this.preValidationInfo.outOfBoundsPlayers.forEach((player) => {
      this.playerPositions = this.playerPositions.filter(p => p.name !== player.name);
    });

    // All remaining players are added here
    this.preValidationInfo.players = [...this.playerPositions];
  }

  async fetchNewDirectionFromBots(nextTickInfo: NextTickInfo) {
    (await Promise.all(this.playerPositions.map(async (player: PlayerPosition) => {
      const playerSetup = <PlayerSetup>this.gameConfig.players.find(p => p.name === player.name);
      try {
        // Only fetch new directions via api on start of sub tick sequence
        if (this.subTick === 1) {
          const payload = await getDirectionsFromBot({
            currentPlayer: playerSetup,
            ...nextTickInfo
          });

          // If not valid, error is thrown
          const directions = getValidatedBotDirections(payload, this.gameConfig);
          this.cachedDirections[player.name] = directions;
        }
        return null;
      } catch (cause) {
        return {
          playerSetup,
          cause
        };
      }
    })))
      .filter(item => item) // Filter out successfulls (promise has returned null for valid ones)
      .forEach(({ playerSetup, cause }: any) => {
        // Players can lose at this point if directions are invalid or timeout is exceeded
        this.playerLost(playerSetup, cause);
      });
  }

  statusCheck() {
    this.preValidationInfo.outOfBoundsPlayers.forEach((player) => {
      const playerSetup = <PlayerSetup>this.gameConfig.players.find(p => p.name === player.name);
      this.playerLost(playerSetup, 'Player moved out of bounds');
    });

    this.preValidationInfo.collisions.forEach((collision) => {
      collision.players.forEach((player) => {
        const playerSetup = <PlayerSetup>this.gameConfig.players.find(p => p.name === player.name);
        this.playerLost(playerSetup, collision.hasBomb ? 'Player stepped on a BOMB' : 'Player crashed to other player');
      });
    });

    // Make the game end if 1. all players are lost, 2. there is only one player left 3. game has been running long enough
    if (this.lostPlayers.length === this.gameConfig.players.length || this.preValidationInfo.players.length === 1 ||
      this.currentTick === this.gameConfig.setup.maxNumOfTicks - 1) {
      this.gameEnded = true;
    }
  }

  getHighscores(): HighScoreInfo {
    let winner;
    const scores = this.lostPlayers;
    if (this.playerPositions.length === 1) {
      winner = {
        ...(<PlayerSetup>this.gameConfig.players.find(p => p.name === this.playerPositions[0].name)),
        highScore: this.currentTick
      };
      scores.push(winner);
    }
    if (this.playerPositions.length > 1) {
      // In tie situation, push all remaining players to scores array with currentTick number as high score
      scores.push(...this.playerPositions.map(remainingPlayer => ({
        ...(<PlayerSetup>this.gameConfig.players.find(p => p.name === remainingPlayer.name)),
        highScore: this.currentTick
      })));
    }
    return {
      winner,
      scores,
      id: this.socket.id,
      result: winner ? 'WINNER_FOUND' : 'TIE'
    };
  }

  removeExplodedBombs() {
    this.otherItems = this.otherItems.filter((item) => {
      if (item.type !== 'BOMB') {
        return item;
      }

      if (!coordinateIsInUse(item, this.preValidationInfo.collisions.filter(collision => collision.hasBomb))) {
        return item;
      }
    });
  }

  updateGameSetup(setup: GameSetup) {
    this.gameSetupUpdate = setup;
  }

  async start() {
    this.positionPlayers();
    this.socket.emit('GAME_STARTED', { id: this.socket.id });
    this.gameStarted = true;
    this.preValidationInfo.collisions = [];
    this.otherItems = [];
    while (!this.gameEnded) {
      if (this.subTick === this.gameConfig.setup.numOfTasksPerTick) {
        this.subTick = 0;
        // Apply new game config
        if (this.gameSetupUpdate) {
          this.gameConfig.setup = this.gameSetupUpdate;
          this.gameSetupUpdate = null;
        }
      }
      this.subTick += 1;
      this.removeExplodedBombs();
      this.resetPreValidationInfo();
      const nextTickInfo = this.getNextTickInfo();
      this.socket.emit('NEXT_TICK', nextTickInfo);
      await this.fetchNewDirectionFromBots(nextTickInfo);
      this.executeDirectionsOfAllBots();
      this.statusCheck();
      this.currentTick = this.currentTick + 1;
      await wait(this.gameConfig.setup.speed);
    }

    this.socket.emit('GAME_ENDED', this.getHighscores());
  }
}
