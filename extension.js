// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const axios = require('axios');
const { Octokit } = require('@octokit/rest');
const keytar = require('keytar');

const JULES_API_BASE_URL = 'https://jules.googleapis.com';

let octokit;

async function getApiKey(service) {
	return await keytar.getPassword('jules-vscode', service);
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "jules" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with  registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('jules.helloWorld', function () {
		// The code you place here will be executed every time your command is executed

		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from Jules!');
	});

	const startChatCommand = vscode.commands.registerCommand('jules.startChat', async () => {
		const panel = vscode.window.createWebviewPanel(
			'chatPanel',
			'Jules Chat',
			vscode.ViewColumn.One,
			{}
		);

		panel.webview.html = getWebviewContent("Creating session...");

		try {
			const session = await createSession();
			panel.webview.html = getWebviewContent(`Session created: ${session.name}`, session.name);

			panel.webview.onDidReceiveMessage(
				async message => {
					switch (message.command) {
						case 'sendMessage':
							try {
								const response = await sendMessage(message.sessionId, message.text);
								panel.webview.postMessage({ text: response.message, plan: response.plan });
							} catch (error) {
								panel.webview.postMessage({ text: `Error: ${error.message}` });
								console.error(error);
							}
							return;
						case 'approvePlan':
							try {
								await approvePlan(message.sessionId, message.planId);
								panel.webview.postMessage({ text: 'Plan approved! Creating pull request...' });
								const pr = await createPullRequest('jules-branch', 'Jules PR', 'This is a PR created by Jules.');
								panel.webview.postMessage({ pr: pr });
							} catch (error) {
								panel.webview.postMessage({ text: `Error: ${error.message}` });
								console.error(error);
							}
							return;
						case 'rejectPlan':
							panel.webview.postMessage({ text: 'Plan rejected.' });
							return;
						case 'checkoutPullRequest':
							try {
								await checkoutPullRequest(message.pullRequestNumber);
								panel.webview.postMessage({ text: `Checked out PR #${message.pullRequestNumber}` });
							} catch (error) {
								panel.webview.postMessage({ text: `Error: ${error.message}` });
								console.error(error);
							}
							return;
						case 'mergePullRequest':
							try {
								await mergePullRequest(message.pullRequestNumber);
								panel.webview.postMessage({ text: `Merged PR #${message.pullRequestNumber}` });
							} catch (error) {
								panel.webview.postMessage({ text: `Error: ${error.message}` });
								console.error(error);
							}
							return;
					}
				},
				undefined,
				context.subscriptions
			);

		} catch (error) {
			panel.webview.html = getWebviewContent(`Error creating session: ${error.message}`);
			console.error(error);
		}
	});

	context.subscriptions.push(disposable, startChatCommand);

	const setJulesApiKeyCommand = vscode.commands.registerCommand('jules.setJulesApiKey', async () => {
		const apiKey = await vscode.window.showInputBox({ prompt: 'Enter your Jules API Key' });
		if (apiKey) {
			await keytar.setPassword('jules-vscode', 'jules', apiKey);
			vscode.window.showInformationMessage('Jules API Key set successfully.');
		}
	});

	const setGitHubTokenCommand = vscode.commands.registerCommand('jules.setGitHubToken', async () => {
		const token = await vscode.window.showInputBox({ prompt: 'Enter your GitHub Token' });
		if (token) {
			await keytar.setPassword('jules-vscode', 'github', token);
			vscode.window.showInformationMessage('GitHub Token set successfully.');
		}
	});

	context.subscriptions.push(setJulesApiKeyCommand, setGitHubTokenCommand);
}

async function sendMessage(sessionId, message) {
	const apiKey = await getApiKey('jules');
	if (!apiKey) {
		throw new Error('Jules API key not set. Please run the "Set Jules API Key" command.');
	}
	const response = await axios.post(`${JULES_API_BASE_URL}/v1alpha/${sessionId}:sendMessage`, {
		message: {
			text: message,
		}
	}, {
		headers: {
			'Content-Type': 'application/json',
			'x-goog-api-key': apiKey,
		}
	});
	return response.data;
}

async function approvePlan(sessionId, planId) {
	const apiKey = await getApiKey('jules');
	if (!apiKey) {
		throw new Error('Jules API key not set. Please run the "Set Jules API Key" command.');
	}
	const response = await axios.post(`${JULES_API_BASE_URL}/v1alpha/${sessionId}:approvePlan`, {
		planId: planId,
	}, {
		headers: {
			'Content-Type': 'application/json',
			'x-goog-api-key': apiKey,
		}
	});
	return response.data;
}

function getGitConfig() {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		return null;
	}
	const workspacePath = workspaceFolders[0].uri.fsPath;
	const fs = require('fs');
	const gitConfig = fs.readFileSync(`${workspacePath}/.git/config`, 'utf8');
	const urlMatch = gitConfig.match(/url = (.*)/);
	if (!urlMatch) {
		return null;
	}
	const url = urlMatch[1];
	const httpsMatch = url.match(/github\.com\/(.*)\/(.*)/);
	if (httpsMatch) {
		const [, owner, repo] = httpsMatch;
		return { owner, repo: repo.replace('.git', '') };
	}
	const sshMatch = url.match(/git@github\.com:(.*)\/(.*)/);
	if (sshMatch) {
		const [, owner, repo] = sshMatch;
		return { owner, repo: repo.replace('.git', '') };
	}
	return null;
}

async function getCurrentBranch() {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		return null;
	}
	const workspacePath = workspaceFolders[0].uri.fsPath;
	const exec = require('util').promisify(require('child_process').exec);
	const { stdout } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: workspacePath });
	return stdout.trim();
}

async function createPullRequest(branch, title, body) {
	const token = await getApiKey('github');
	if (!token) {
		throw new Error('GitHub token not set. Please run the "Set GitHub Token" command.');
	}
	octokit = new Octokit({ auth: token });

	const { owner, repo } = getGitConfig();
	const head = `${owner}:${branch}`;
	const base = await getCurrentBranch();

	const response = await octokit.pulls.create({
		owner,
		repo,
		head,
		base,
		title,
		body,
	});

	return response.data;
}

async function checkoutPullRequest(pullRequestNumber) {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		vscode.window.showErrorMessage('No workspace folder open.');
		return;
	}
	const workspacePath = workspaceFolders[0].uri.fsPath;

	const exec = require('util').promisify(require('child_process').exec);
	await exec(`git fetch origin pull/${pullRequestNumber}/head:pr-${pullRequestNumber}`, { cwd: workspacePath });
	await exec(`git checkout pr-${pullRequestNumber}`, { cwd: workspacePath });
}

async function mergePullRequest(pullRequestNumber) {
	const token = await getApiKey('github');
	if (!token) {
		throw new Error('GitHub token not set. Please run the "Set GitHub Token" command.');
	}
	octokit = new Octokit({ auth: token });

	const { owner, repo } = getGitConfig();
	const response = await octokit.pulls.merge({
		owner,
		repo,
		pull_number: pullRequestNumber,
	});
	return response.data;
}

async function createSession() {
	const apiKey = await getApiKey('jules');
	if (!apiKey) {
		throw new Error('Jules API key not set. Please run the "Set Jules API Key" command.');
	}
	const response = await axios.post(`${JULES_API_BASE_URL}/v1alpha/sessions`, {}, {
		headers: {
			'Content-Type': 'application/json',
			'x-goog-api-key': apiKey,
		}
	});
	return response.data;
}

function getWebviewContent(content, sessionId) {
	return `<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Jules Chat</title>
	</head>
	<body>
		<h1>Jules Chat</h1>
		<div id="messages"></div>
		<input type="text" id="message-input" placeholder="Type your message...">
		<button id="send-button">Send</button>

		<div id="plan-container" style="display: none;">
			<h2>Plan</h2>
			<div id="plan"></div>
			<button id="approve-button">Approve</button>
			<button id="reject-button">Reject</button>
		</div>

		<div id="pr-container" style="display: none;">
			<h2>Pull Request</h2>
			<a id="pr-link" href="#"></a>
			<button id="checkout-pr-button">Checkout PR</button>
			<button id="merge-pr-button">Merge PR</button>
		</div>

		<script>
			const vscode = acquireVsCodeApi();
			const messages = document.getElementById('messages');
			const messageInput = document.getElementById('message-input');
			const sendButton = document.getElementById('send-button');
			const planContainer = document.getElementById('plan-container');
			const planDiv = document.getElementById('plan');
			const approveButton = document.getElementById('approve-button');
			const rejectButton = document.getElementById('reject-button');
			const prContainer = document.getElementById('pr-container');
			const prLink = document.getElementById('pr-link');
			const checkoutPrButton = document.getElementById('checkout-pr-button');
			const mergePrButton = document.getElementById('merge-pr-button');

			let currentPlanId;
			let currentPrNumber;

			sendButton.addEventListener('click', () => {
				const message = messageInput.value;
				messageInput.value = '';
				vscode.postMessage({
					command: 'sendMessage',
					text: message,
					sessionId: '${sessionId}'
				});
			});

			approveButton.addEventListener('click', () => {
				vscode.postMessage({
					command: 'approvePlan',
					planId: currentPlanId,
					sessionId: '${sessionId}'
				});
			});

			rejectButton.addEventListener('click', () => {
				vscode.postMessage({
					command: 'rejectPlan',
					planId: currentPlanId,
					sessionId: '${sessionId}'
				});
			});

			checkoutPrButton.addEventListener('click', () => {
				vscode.postMessage({
					command: 'checkoutPullRequest',
					pullRequestNumber: currentPrNumber,
				});
			});

			mergePrButton.addEventListener('click', () => {
				vscode.postMessage({
					command: 'mergePullRequest',
					pullRequestNumber: currentPrNumber,
				});
			});

			window.addEventListener('message', event => {
				const message = event.data;
				if (message.plan) {
					planDiv.textContent = message.plan.description;
					currentPlanId = message.plan.id;
					planContainer.style.display = 'block';
				} else if (message.pr) {
					prLink.href = message.pr.html_url;
					prLink.textContent = 'PR #' + message.pr.number;
					currentPrNumber = message.pr.number;
					prContainer.style.display = 'block';
				}
				const messageElement = document.createElement('div');
				messageElement.textContent = message.text;
				messages.appendChild(messageElement);
			});
		</script>
	</body>
	</html>`;
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
